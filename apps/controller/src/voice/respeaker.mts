// Maps voice state to a ReSpeaker LED appearance. The vendor protocol and USB
// transport live in xvf3800-device.mts and the frame streaming in
// led-renderer.mts; this module only decides which appearance the current
// state should show.

import type {LedAppearance} from './led-appearance.mjs'
import {Leds} from './led-appearance.mjs'
import {LedRenderer} from './led-renderer.mjs'
import {VOICE_LED_STATES} from './led-states.mjs'
import {Xvf3800Device} from './xvf3800-device.mjs'
import type {LedDevice, LvaMessage, ReSpeakerConfig} from '../types.mjs'

export interface ReSpeakerControllerOptions {
    config: ReSpeakerConfig
    device?: LedDevice
    voiceEnabled?: boolean
    now?: () => number
    warningIntervalMilliseconds?: number
    logger?: Pick<Console, 'warn'>
}

export class ReSpeakerController {
    readonly config: ReSpeakerConfig
    private readonly states: ReadonlyMap<string, LedAppearance> = VOICE_LED_STATES
    private readonly renderer: LedRenderer
    private assistState = 'disconnected'
    private muted = false

    constructor({
                    config,
                    device,
                    voiceEnabled = true,
                    now,
                    warningIntervalMilliseconds,
                    logger,
                }: ReSpeakerControllerOptions) {
        this.config = config
        this.renderer = new LedRenderer({
            device: device ?? new Xvf3800Device({
                vendorId: Number(config.vendor_id),
                productId: Number(config.product_id),
            }),
            brightness: config.brightness ?? 64,
            // The firmware speed for breath and rainbow; a state that needs its own
            // pace sets it on the appearance in led-states.mts instead.
            speed: 2,
            now,
            warningIntervalMilliseconds,
            logger,
        })
        // An LED-only installation has no LVA socket to transition away from the
        // disconnected state, so begin at the normal idle appearance instead.
        if (!voiceEnabled) this.assistState = 'idle'
    }

    desired(): LedAppearance {
        const current = this.muted ? 'muted' : this.assistState
        return this.states.get(current) ?? this.states.get('idle') ?? Leds.off()
    }

    render(): Promise<void> {
        return this.renderer.show(this.desired())
    }

    start(): void {
        this.renderer.start()
        void this.render()
    }

    stop(): void {
        this.renderer.stop()
    }

    setDisconnected(): Promise<void> {
        this.assistState = 'disconnected'
        return this.render()
    }

    async handleEvent(message: LvaMessage | undefined): Promise<void> {
        const event = message?.event
        const data = message?.data || {}
        if (event === 'snapshot') {
            this.muted = Boolean(data.muted)
            this.assistState = data.ha_connected ? 'idle' : 'disconnected'
        } else if (event === 'muted') {
            this.muted = Boolean(data.muted)
            if (!this.muted) this.assistState = 'idle'
        } else if (event === 'zeroconf' && data.status === 'connected') {
            this.assistState = 'idle'
        } else if (event && this.states.has(event)) {
            this.assistState = String(event)
        } else if ((event === 'media_player_paused' || event === 'media_player_idle')
            && this.assistState === 'media_player_playing') {
            this.assistState = 'idle'
        } else if (event === 'tts_finished' || event === 'idle') {
            this.assistState = 'idle'
        } else if (event === 'timer_updated') {
            this.assistState = 'timer_ticking'
        }
        await this.render()
    }
}
