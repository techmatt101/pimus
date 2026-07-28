import type {LedAnimation} from './animation.mjs'
import {TAU} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {rgb, scaleColor} from './color.mjs'
import {LED_COUNT} from '../../types.mjs'

const PERIOD_MILLISECONDS = 2600
const FRAME_MILLISECONDS = 50

// The ring never reaches black, so a slow breath reads as waiting rather than
// as a ring that keeps switching itself off.
const FLOOR = 0.08

// Squaring the swell holds it longer at the dim end, which is what makes it
// look like breathing rather than a triangle wave.
const EASE = 2

export class Pulse implements LedAnimation {
    readonly color: number
    readonly periodMs: number
    readonly framePeriodMs = FRAME_MILLISECONDS

    constructor(color: ColorInput, periodMs = PERIOD_MILLISECONDS) {
        this.color = rgb(color)
        this.periodMs = periodMs
    }

    ring(nowMs: number): readonly number[] {
        const swell = ((1 - Math.cos((nowMs / this.periodMs) * TAU)) / 2) ** EASE
        return Array<number>(LED_COUNT).fill(
            scaleColor(this.color, FLOOR + (1 - FLOOR) * swell))
    }
}
