import type {LedAppearance} from './led-appearance.mjs'
import {framePeriodMs, Leds, resolveFrame, silentSignals} from './led-appearance.mjs'
import type {LedDevice, LedSignals} from '../types.mjs'

export interface LedRendererOptions {
    device: LedDevice
    brightness: number
    speed: number
    signals?: LedSignals
    now?: () => number
    warningIntervalMilliseconds?: number
    logger?: Pick<Console, 'warn'>
}

/** How often a static appearance is re-checked so USB failures retry. */
const RETRY_MILLISECONDS = 500

/**
 * Streams LED frames to a device. Static appearances are written once and
 * re-verified on a slow watchdog tick so an unplugged ReSpeaker recovers;
 * animated appearances tick at their own rate with the phase derived from
 * the clock.
 */
export class LedRenderer {
    readonly device: LedDevice
    readonly #defaults: { brightness: number; speed: number }
    readonly #signals: LedSignals
    readonly #now: () => number
    readonly #warningIntervalMilliseconds: number
    readonly #logger: Pick<Console, 'warn'>
    #appearance: LedAppearance = Leds.off()
    #renderQueue: Promise<void> = Promise.resolve()
    #timer: NodeJS.Timeout | null = null
    #running = false
    #lastSignature = ''
    #lastWarningAt = Number.NEGATIVE_INFINITY
    #lastWarningSignature = ''

    constructor({
                    device,
                    brightness,
                    speed,
                    signals = silentSignals,
                    now = Date.now,
                    warningIntervalMilliseconds = 30_000,
                    logger = console,
                }: LedRendererOptions) {
        this.device = device
        this.#defaults = {brightness, speed}
        this.#signals = signals
        this.#now = now
        this.#warningIntervalMilliseconds = warningIntervalMilliseconds
        this.#logger = logger
    }

    show(appearance: LedAppearance): Promise<void> {
        this.#appearance = appearance
        this.#schedule()
        return this.render()
    }

    start(): void {
        this.#running = true
        this.#schedule()
        void this.render()
    }

    stop(): void {
        this.#running = false
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
    }

    render(): Promise<void> {
        this.#renderQueue = this.#renderQueue.then(async () => {
            const frame = resolveFrame(this.#appearance, this.#now(), this.#defaults, this.#signals)
            const signature = JSON.stringify(frame)
            if (signature === this.#lastSignature) return
            try {
                await this.device.apply(frame)
                this.#lastSignature = signature
                this.#lastWarningSignature = ''
                this.#lastWarningAt = Number.NEGATIVE_INFINITY
            } catch (error) {
                // The next tick retries with a fresh device handle; repeat
                // failures are logged once per interval rather than per tick.
                this.#lastSignature = ''
                const warningSignature = String(error)
                const now = this.#now()
                if (warningSignature !== this.#lastWarningSignature
                    || now - this.#lastWarningAt >= this.#warningIntervalMilliseconds) {
                    this.#logger.warn('Unable to update ReSpeaker LEDs', error)
                    this.#lastWarningSignature = warningSignature
                    this.#lastWarningAt = now
                }
            }
        })
        return this.#renderQueue
    }

    #schedule(): void {
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
        if (!this.#running) return
        const interval = framePeriodMs(this.#appearance) ?? RETRY_MILLISECONDS
        this.#timer = setInterval(() => void this.render(), interval)
    }
}
