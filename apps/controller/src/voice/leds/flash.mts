import type {LedAnimation} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {rgb, scaleColor} from './color.mjs'
import {LED_COUNT} from '../../types.mjs'

const DURATION_MILLISECONDS = 500
const FRAME_MILLISECONDS = 40

/** Reached quickly and left slowly, so the ring blips rather than blinks. */
const PEAK = 0.2

/** The whole ring lit once and faded out, from the instant it was asked for. */
export class Flash implements LedAnimation {
    readonly color: number
    readonly startedAt: number
    readonly durationMs: number
    readonly framePeriodMs = FRAME_MILLISECONDS

    constructor(color: ColorInput, startedAt: number, durationMs = DURATION_MILLISECONDS) {
        this.color = rgb(color)
        this.startedAt = startedAt
        this.durationMs = durationMs
    }

    ring(nowMs: number): readonly number[] {
        const progress = (nowMs - this.startedAt) / this.durationMs
        if (progress < 0 || progress >= 1) return Array<number>(LED_COUNT).fill(0)
        const level = progress < PEAK
            ? progress / PEAK
            : (1 - (progress - PEAK) / (1 - PEAK)) ** 2
        return Array<number>(LED_COUNT).fill(scaleColor(this.color, level))
    }
}
