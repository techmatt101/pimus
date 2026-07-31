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

// An array whose power has just come back enumerates before its firmware has
// finished starting, and a frame written into that window is accepted over USB
// and then lost to the firmware's own direction-of-arrival default. Nothing
// errors, so one successful write is no proof the face took: the whole frame is
// rewritten on a slow tick until the device has been answering for this long.
const SETTLE_MILLISECONDS = 20_000
const SETTLE_TICK_MILLISECONDS = 1000

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
    #settleTimer: NodeJS.Timeout | null = null
    #settleUntil = 0
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
        this.#settle()
        void this.#rewrite()
    }

    stop(): void {
        this.#running = false
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
        this.#stopSettling()
    }

    /** The device re-enumerated: rewrite the current face from scratch. */
    reattach(): Promise<void> {
        this.#settle()
        return this.#rewrite()
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
                // A device still coming back has not started settling yet, so
                // the window is counted from the first write it answers.
                if (this.#settleTimer) this.#settleUntil = this.#now() + SETTLE_MILLISECONDS
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

    #rewrite(): Promise<void> {
        this.#lastSignature = ''
        this.device.reattach?.()
        return this.render()
    }

    #settle(): void {
        this.#settleUntil = this.#now() + SETTLE_MILLISECONDS
        if (this.#settleTimer) return
        this.#settleTimer = setInterval(() => {
            if (this.#now() >= this.#settleUntil) this.#stopSettling()
            else void this.#rewrite()
        }, SETTLE_TICK_MILLISECONDS)
        this.#settleTimer.unref()
    }

    #stopSettling(): void {
        if (this.#settleTimer) clearInterval(this.#settleTimer)
        this.#settleTimer = null
    }

    #schedule(): void {
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
        if (!this.#running) return
        const interval = this.#animation.framePeriodMs ?? RETRY_MILLISECONDS
        this.#timer = setInterval(() => void this.render(), interval)
    }
}
