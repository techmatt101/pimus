// Streams LED frames to a device. Static appearances are written once and
// re-verified on a slow watchdog tick so an unplugged ReSpeaker recovers;
// animated appearances (spin, blink) tick at their own rate with the phase
// derived from the clock. Which appearance the voice state should show stays
// in respeaker.mts; the USB protocol stays in xvf3800-device.mts.

import type {LedAppearance} from './led-appearance.mjs'
import {framePeriodMs, Leds, resolveFrame} from './led-appearance.mjs'
import type {LedDevice} from '../types.mjs'

export interface LedRendererOptions {
    device: LedDevice
    brightness: number
    speed: number
    now?: () => number
    warningIntervalMilliseconds?: number
    logger?: Pick<Console, 'warn'>
}

/** How often a static appearance is re-checked so USB failures retry. */
const RETRY_MILLISECONDS = 500

export class LedRenderer {
    readonly device: LedDevice
    private readonly defaults: { brightness: number; speed: number }
    private readonly now: () => number
    private readonly warningIntervalMilliseconds: number
    private readonly logger: Pick<Console, 'warn'>
    private appearance: LedAppearance = Leds.off()
    private renderQueue: Promise<void> = Promise.resolve()
    private timer: NodeJS.Timeout | null = null
    private running = false
    private lastSignature = ''
    private lastWarningAt = Number.NEGATIVE_INFINITY
    private lastWarningSignature = ''

    constructor({
                    device,
                    brightness,
                    speed,
                    now = Date.now,
                    warningIntervalMilliseconds = 30_000,
                    logger = console,
                }: LedRendererOptions) {
        this.device = device
        this.defaults = {brightness, speed}
        this.now = now
        this.warningIntervalMilliseconds = warningIntervalMilliseconds
        this.logger = logger
    }

    /** Switches to an appearance and writes its first frame immediately. */
    show(appearance: LedAppearance): Promise<void> {
        this.appearance = appearance
        this.schedule()
        return this.render()
    }

    start(): void {
        this.running = true
        this.schedule()
        void this.render()
    }

    stop(): void {
        this.running = false
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    render(): Promise<void> {
        this.renderQueue = this.renderQueue.then(async () => {
            const frame = resolveFrame(this.appearance, this.now(), this.defaults)
            const signature = JSON.stringify(frame)
            if (signature === this.lastSignature) return
            try {
                await this.device.apply(frame)
                this.lastSignature = signature
                this.lastWarningSignature = ''
                this.lastWarningAt = Number.NEGATIVE_INFINITY
            } catch (error) {
                // USB devices can be unplugged or re-enumerated; the next tick retries
                // and Xvf3800Device opens a fresh handle. Repeat failures are logged
                // once per interval rather than per tick.
                this.lastSignature = ''
                const warningSignature = String(error)
                const now = this.now()
                if (warningSignature !== this.lastWarningSignature
                    || now - this.lastWarningAt >= this.warningIntervalMilliseconds) {
                    this.logger.warn('Unable to update ReSpeaker LEDs', error)
                    this.lastWarningSignature = warningSignature
                    this.lastWarningAt = now
                }
            }
        })
        return this.renderQueue
    }

    private schedule(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        if (!this.running) return
        const interval = framePeriodMs(this.appearance) ?? RETRY_MILLISECONDS
        this.timer = setInterval(() => void this.render(), interval)
    }
}
