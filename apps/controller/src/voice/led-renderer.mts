import type {LedAnimation} from './leds/animation.mjs'
import {silentSignals} from './leds/animation.mjs'
import {Dark} from './leds/dark.mjs'
import type {LedDevice, LedFrame, LedSignals} from '../types.mjs'
import {LedEffect} from '../types.mjs'

export interface LedRendererOptions {
    device: LedDevice
    brightness: number
    signals?: LedSignals
    now?: () => number
    warningIntervalMilliseconds?: number
    logger?: Pick<Console, 'warn'>
}

/** How often a static face is re-checked so USB failures retry. */
const RETRY_MILLISECONDS = 500

/**
 * Streams LED frames to a device. A face that never changes is written once and
 * re-verified on a slow watchdog tick so an unplugged ReSpeaker recovers; an
 * animated one ticks at the rate it asks for, drawing itself from the clock.
 */
export class LedRenderer {
    readonly device: LedDevice
    readonly #brightness: number
    readonly #signals: LedSignals
    readonly #now: () => number
    readonly #warningIntervalMilliseconds: number
    readonly #logger: Pick<Console, 'warn'>
    #animation: LedAnimation = new Dark()
    #renderQueue: Promise<void> = Promise.resolve()
    #timer: NodeJS.Timeout | null = null
    #running = false
    #lastSignature = ''
    #lastWarningAt = Number.NEGATIVE_INFINITY
    #lastWarningSignature = ''

    constructor({
                    device,
                    brightness,
                    signals = silentSignals,
                    now = Date.now,
                    warningIntervalMilliseconds = 30_000,
                    logger = console,
                }: LedRendererOptions) {
        this.device = device
        this.#brightness = brightness
        this.#signals = signals
        this.#now = now
        this.#warningIntervalMilliseconds = warningIntervalMilliseconds
        this.#logger = logger
    }

    show(animation: LedAnimation): Promise<void> {
        this.#animation = animation
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
            const frame = this.#frame()
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

    #frame(): LedFrame {
        const ring = this.#animation.ring(this.#now(), this.#signals)
        if (!ring) return {effect: LedEffect.Off, brightness: this.#brightness}
        return {effect: LedEffect.Ring, brightness: this.#brightness, ring}
    }

    #schedule(): void {
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
        if (!this.#running) return
        const interval = this.#animation.framePeriodMs ?? RETRY_MILLISECONDS
        this.#timer = setInterval(() => void this.render(), interval)
    }
}
