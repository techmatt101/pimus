import type {Binding} from './bindings.mjs'
import type {Dial} from './dial.mjs'

export interface LevelDialHandlers {
    read(): number | undefined

    apply(percent: number): void

    onConfirm(): void
}

/**
 * A "turn to adjust, press to finish" knob for a 0-100 level: each detent
 * steps the live value and applies it immediately, clamped at the ends rather
 * than wrapping. The owning tile says where the value lives and what
 * finishing does; the timeout and "another dial cancels" belong to the
 * shared dial.
 */
export class LevelDial implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #step: number
    readonly #handlers: LevelDialHandlers

    constructor(label: string, handlers: LevelDialHandlers, step = 5) {
        this.label = label
        this.#handlers = handlers
        this.#step = step
        this.left = {action: {type: 'noop'}, run: () => this.#turn(-1)}
        this.right = {action: {type: 'noop'}, run: () => this.#turn(1)}
        this.press = {action: {type: 'noop'}, run: () => this.#handlers.onConfirm()}
    }

    #turn(direction: number): void {
        const current = this.#handlers.read()
        if (current === undefined) return
        this.#handlers.apply(Math.max(0, Math.min(100, current + direction * this.#step)))
    }

    detail(): string {
        const value = this.#handlers.read()
        return value === undefined ? '?' : `${value}%`
    }

    level(): number | undefined {
        const value = this.#handlers.read()
        return value === undefined ? undefined : value / 100
    }
}
