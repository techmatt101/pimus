import type {LedAnimation} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {rgb} from './color.mjs'
import {LED_COUNT} from '../../types.mjs'

const PERIOD_MILLISECONDS = 800

/** The whole ring flashing on and off, for something that wants answering. */
export class Blink implements LedAnimation {
    readonly color: number
    readonly periodMs: number

    constructor(color: ColorInput, periodMs = PERIOD_MILLISECONDS) {
        this.color = rgb(color)
        this.periodMs = periodMs
    }

    get framePeriodMs(): number {
        return this.periodMs / 2
    }

    ring(nowMs: number): readonly number[] {
        const lit = Math.floor(nowMs / (this.periodMs / 2)) % 2 === 0
        return Array<number>(LED_COUNT).fill(lit ? this.color : 0)
    }
}
