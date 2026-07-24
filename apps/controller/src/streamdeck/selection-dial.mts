import type {Binding} from './bindings.mjs'
import type {Dial} from './dial.mjs'

export interface SelectionOption {
    label: string
}

export interface SelectionHandlers<T extends SelectionOption> {
    onConfirm(option: T): void
    onChange(): void
}

/**
 * A "pick one from a list, then confirm" knob: turning steps through the
 * choices without acting, pressing commits the one showing. The owning tile
 * says what a choice is and what confirming does; the timeout and
 * "another dial cancels" belong to the shared dial.
 */
export class SelectionDial<T extends SelectionOption> implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #options: readonly T[]
    readonly #handlers: SelectionHandlers<T>
    index = 0

    constructor(
        label: string,
        options: readonly T[],
        handlers: SelectionHandlers<T>,
    ) {
        this.label = label
        this.#options = options
        this.#handlers = handlers
        this.left = {action: {type: 'noop'}, run: () => this.#step(-1)}
        this.right = {action: {type: 'noop'}, run: () => this.#step(1)}
        this.press = {action: {type: 'noop'}, run: () => this.#confirm()}
    }

    get selected(): T | undefined {
        return this.#options[this.index]
    }

    detail(): string {
        return this.selected?.label ?? '--'
    }

    #step(delta: number): void {
        const count = this.#options.length
        if (count === 0) return
        this.index = ((this.index + delta) % count + count) % count
        this.#handlers.onChange()
    }

    #confirm(): void {
        const option = this.selected
        if (option) this.#handlers.onConfirm(option)
    }
}
