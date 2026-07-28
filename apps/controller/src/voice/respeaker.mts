import type {LedAppearance} from './led-appearance.mjs'
import {Leds, signalDemand} from './led-appearance.mjs'
import {LedRenderer} from './led-renderer.mjs'
import {VOICE_LED_STATES} from './led-states.mjs'
import {MicSensor, silentSensor} from './mic-sensor.mjs'
import {Xvf3800Device} from './xvf3800-device.mjs'
import type {LedDevice, LedSignals, LvaMessage, ReSpeakerConfig, VoiceSensor} from '../types.mjs'

// The controller now starts well before Linux Voice Assistant finishes waiting
// for the audio graph, so a first connection that has not happened yet is a wait
// rather than a loss. After this the ring stops making excuses and shows red.
const BOOT_GRACE_MILLISECONDS = 90_000

export interface ReSpeakerControllerOptions {
    config: ReSpeakerConfig
    device?: LedDevice
    sensor?: VoiceSensor
    voiceEnabled?: boolean
    /** How loudly the assistant is speaking, 0..1, metered by the audio manager. */
    speechLevel?: () => number
    /** Asked for that metering only while a state is painting from it. */
    onSpeechMeter?: (active: boolean) => void
    now?: () => number
    warningIntervalMilliseconds?: number
    logger?: Pick<Console, 'warn'>
}

export class ReSpeakerController {
    readonly config: ReSpeakerConfig
    readonly #states: ReadonlyMap<string, LedAppearance> = VOICE_LED_STATES
    readonly #renderer: LedRenderer
    readonly #mic: MicSensor
    readonly #onSpeechMeter: (active: boolean) => void
    #assistState = 'starting'
    #muted = false
    #speechMetered = false
    #bootTimer: NodeJS.Timeout | null = null

    constructor({
                    config,
                    device,
                    sensor,
                    voiceEnabled = true,
                    speechLevel = () => 0,
                    onSpeechMeter = () => {
                    },
                    now,
                    warningIntervalMilliseconds,
                    logger,
                }: ReSpeakerControllerOptions) {
        this.config = config
        this.#onSpeechMeter = onSpeechMeter
        // Constructing the device opens nothing: it finds its handle on the
        // first transfer, so an injected LED surface or sensor still stands in.
        const hardware = new Xvf3800Device({
            vendorId: Number(config.vendor_id),
            productId: Number(config.product_id),
        })
        // The array and the ring are one device: a caller that replaced the ring
        // has replaced the hardware, and must be given no sensing it did not.
        this.#mic = new MicSensor({
            sensor: sensor ?? (device ? silentSensor : hardware),
            now,
            logger,
        })
        const signals: LedSignals = {
            micLevel: () => this.#mic.level(),
            micDirection: () => this.#mic.direction(),
            speechLevel: () => speechLevel(),
        }
        this.#renderer = new LedRenderer({
            device: device ?? hardware,
            brightness: config.brightness ?? 64,
            // Firmware speed for breath and rainbow; a state needing its own
            // pace sets it on the appearance in led-states.mts.
            speed: 2,
            signals,
            now,
            warningIntervalMilliseconds,
            logger,
        })
        // An LED-only installation has no LVA socket to ever leave the
        // disconnected state, so begin at idle.
        if (!voiceEnabled) this.#assistState = 'idle'
    }

    desired(): LedAppearance {
        const current = this.#muted ? 'muted' : this.#assistState
        return this.#states.get(current) ?? this.#states.get('idle') ?? Leds.off()
    }

    render(): Promise<void> {
        const appearance = this.desired()
        this.#demand(signalDemand(appearance))
        return this.#renderer.show(appearance)
    }

    start(): void {
        this.#renderer.start()
        if (this.#assistState === 'starting') {
            this.#bootTimer = setTimeout(() => {
                this.#bootTimer = null
                if (this.#assistState === 'starting') void this.setDisconnected()
            }, BOOT_GRACE_MILLISECONDS)
            this.#bootTimer.unref()
        }
        void this.render()
    }

    stop(): void {
        this.#clearBootTimer()
        this.#demand({mic: false, speech: false})
        this.#renderer.stop()
    }

    /** Darkens the ring so a stopped controller does not leave a state showing. */
    async release(): Promise<void> {
        this.#clearBootTimer()
        this.#demand({mic: false, speech: false})
        await this.#renderer.show(Leds.off())
        this.#renderer.stop()
    }

    #demand({mic, speech}: { mic: boolean; speech: boolean }): void {
        if (mic) this.#mic.start()
        else this.#mic.stop()
        if (speech === this.#speechMetered) return
        this.#speechMetered = speech
        this.#onSpeechMeter(speech)
    }

    setDisconnected(): Promise<void> {
        this.#assistState = this.#bootTimer ? 'starting' : 'disconnected'
        return this.render()
    }

    #clearBootTimer(): void {
        if (this.#bootTimer) clearTimeout(this.#bootTimer)
        this.#bootTimer = null
    }

    async handleEvent(message: LvaMessage | undefined): Promise<void> {
        // Any event at all proves the socket came up, so boot is over.
        this.#clearBootTimer()
        const event = message?.event
        const data = message?.data || {}
        if (event === 'snapshot') {
            this.#muted = Boolean(data.muted)
            this.#assistState = data.ha_connected ? 'idle' : 'disconnected'
        } else if (event === 'muted') {
            this.#muted = Boolean(data.muted)
            if (!this.#muted) this.#assistState = 'idle'
        } else if (event === 'zeroconf' && data.status === 'connected') {
            this.#assistState = 'idle'
        } else if (event && this.#states.has(event)) {
            this.#assistState = String(event)
        } else if (event === 'tts_finished' || event === 'idle') {
            this.#assistState = 'idle'
        } else if (event === 'timer_updated') {
            this.#assistState = 'timer_ticking'
        }
        await this.render()
    }
}
