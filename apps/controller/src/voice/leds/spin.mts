import type {LedAnimation} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {rgb, scaleColor} from './color.mjs'
import {LED_COUNT} from '../../types.mjs'

/** One full turn. */
const PERIOD_MILLISECONDS = 1400

const OPPOSITE = LED_COUNT / 2

// The head plus three fading behind it. Longer than the gap between the two
// heads would have each tail run into the LED opposite, leaving a lit ring
// rather than something turning.
const TAIL = 4

/** Fades away quadratically, so the LED just behind the head still reads as lit. */
const ghost = (behind: number) => behind < TAIL ? (1 - behind / TAIL) ** 2 : 0

export type SpinDirection = 'clockwise' | 'counter-clockwise'

export interface SpinOptions {
    direction?: SpinDirection
    periodMs?: number
}

/** One colour for both heads, or one each so the two can be told apart. */
export type SpinColors = ColorInput | readonly [ColorInput, ColorInput]

/** Two LEDs facing each other, travelling round the ring behind fading tails. */
export class Spin implements LedAnimation {
    readonly colors: readonly [number, number]
    readonly direction: SpinDirection
    readonly periodMs: number

    constructor(colors: SpinColors, options: SpinOptions = {}) {
        const [leading, opposite] = Array.isArray(colors) ? colors : [colors, colors] as const
        this.colors = [rgb(leading), rgb(opposite)]
        this.direction = options.direction ?? 'clockwise'
        this.periodMs = options.periodMs ?? PERIOD_MILLISECONDS
    }

    get framePeriodMs(): number {
        return this.periodMs / LED_COUNT
    }

    ring(nowMs: number): readonly number[] {
        const head = this.#head(nowMs)
        return Array.from({length: LED_COUNT}, (_, index) => {
            // How far the LED sits behind the leading head, taken the way the
            // ring is turning; past the halfway mark it is trailing the other.
            const behind = this.direction === 'clockwise'
                ? (head - index + LED_COUNT) % LED_COUNT
                : (index - head + LED_COUNT) % LED_COUNT
            return scaleColor(this.colors[behind < OPPOSITE ? 0 : 1], ghost(behind % OPPOSITE))
        })
    }

    #head(nowMs: number): number {
        const step = Math.floor(nowMs / this.framePeriodMs)
        return (((this.direction === 'clockwise' ? step : -step) % LED_COUNT) + LED_COUNT) % LED_COUNT
    }
}
