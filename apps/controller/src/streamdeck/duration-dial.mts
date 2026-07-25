import {formatDuration} from '../home-assistant/entity.mjs'
import type {Binding} from './bindings.mjs'
import type {Dial} from './dial.mjs'

export interface DurationHandlers {
    onConfirm(seconds: number): void
    onChange(): void
}

const MIN_SECONDS = 1
// 59:00 is the ceiling, so the readout never needs an hours field that would
// read the same as a minutes-and-seconds value ("1:30").
const MAX_SECONDS = 59 * 60

/**
 * The detent grows with the value, so the low end is fine and the high end is
 * quick: a second under ten, five under a minute, then fifteen, thirty, and a
 * minute a step past ten minutes.
 */
export function durationStep(seconds: number): number {
    if (seconds < 10) return 1
    if (seconds < 60) return 5
    if (seconds < 300) return 15
    if (seconds < 600) return 30
    return 60
}

/**
 * A "set a duration" knob: turning steps the value by a detent that scales with
 * how large it already is, pressing confirms the value showing. The owning tile
 * says what confirming does; the timeout and "another dial cancels" belong to
 * the shared dial, exactly as for `SelectionDial`.
 */
export class DurationDial implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #handlers: DurationHandlers
    #seconds: number

    constructor(label: string, seconds: number, handlers: DurationHandlers) {
        this.label = label
        this.#seconds = clamp(seconds)
        this.#handlers = handlers
        this.left = {action: {type: 'noop'}, run: () => this.#step(-1)}
        this.right = {action: {type: 'noop'}, run: () => this.#step(1)}
        this.press = {action: {type: 'noop'}, run: () => handlers.onConfirm(this.#seconds)}
    }

    get seconds(): number {
        return this.#seconds
    }

    /** Reset to a starting value (the tile's default) as the knob is armed. */
    reset(seconds: number): void {
        this.#seconds = clamp(seconds)
    }

    detail(): string {
        return formatDuration(this.#seconds)
    }

    #step(direction: number): void {
        // Stepping down uses the tier just below the current value, so leaving a
        // boundary returns by the same detent that reached it (60 -> 55, not 45).
        const step = direction > 0 ? durationStep(this.#seconds) : durationStep(this.#seconds - 1)
        this.#seconds = clamp(this.#seconds + direction * step)
        this.#handlers.onChange()
    }
}

function clamp(seconds: number): number {
    return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(seconds)))
}
