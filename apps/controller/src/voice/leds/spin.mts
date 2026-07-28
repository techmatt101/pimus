import type {LedAnimation} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {rgb, scaleColor} from './color.mjs'
import {LED_COUNT} from '../../types.mjs'

/** One full turn; the pattern is symmetric, so it repeats every half of it. */
const PERIOD_MILLISECONDS = 1400

const OPPOSITE = LED_COUNT / 2

// The head plus three fading behind it. Longer than the gap between the two
// heads would have each tail run into the LED opposite, leaving a lit ring
// rather than something turning.
const TAIL = 4

/** Fades away quadratically, so the LED just behind the head still reads as lit. */
const ghost = (behind: number) => behind < TAIL ? (1 - behind / TAIL) ** 2 : 0

/** Two LEDs facing each other, travelling round the ring behind fading tails. */
export class Spin implements LedAnimation {
    readonly color: number
    readonly periodMs: number

    constructor(color: ColorInput, periodMs = PERIOD_MILLISECONDS) {
        this.color = rgb(color)
        this.periodMs = periodMs
    }

    get framePeriodMs(): number {
        return this.periodMs / LED_COUNT
    }

    ring(nowMs: number): readonly number[] {
        const head = Math.floor(nowMs / (this.periodMs / LED_COUNT)) % LED_COUNT
        // The two heads sit half a ring apart, so how far an LED trails the
        // nearer of them is the same sum taken modulo that half.
        return Array.from({length: LED_COUNT},
            (_, index) => scaleColor(this.color, ghost((head - index + LED_COUNT) % OPPOSITE)))
    }
}
