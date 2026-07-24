// A "pick one from a list, then confirm" knob. Turning it steps through a fixed
// list of choices without acting on anything; pressing it commits the one now
// showing. It carries no device knowledge of its own — the tile that owns it
// says what a choice is and what confirming does — so any key with a short list
// to choose from (a playlist, a source, a preset) can hand this to the shared
// dial and get the same select-then-confirm behaviour.
//
// A key claims it exactly as the room keys claim EntityDial
// (streamdeck/dials/dynamic-dial.mts): press the key to arm the dial, turn to
// choose, press again — the key or the knob — to confirm. The 15-second timeout
// and "another dial cancels" belong to the shared dial, not here, so this class
// stays a plain readout-and-step.

import type {Binding} from '../bindings.mjs'
import type {Dial} from './dial.mjs'

/** The least a choice must carry: the label shown while it is the pick. */
export interface SelectionOption {
    label: string
}

/** How the owning tile is told when the pick moves or is confirmed. */
export interface SelectionHandlers<T extends SelectionOption> {
    /** Commit the choice now showing. The tile plays it and releases the dial. */
    onConfirm(option: T): void
    /** The pick moved: repaint the key face and the strip readout. */
    onChange(): void
}

export class SelectionDial<T extends SelectionOption> implements Dial {
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    /** Which choice is showing, so the owning key can draw a dot per option. */
    index = 0

    constructor(
        readonly label: string,
        private readonly options: readonly T[],
        private readonly handlers: SelectionHandlers<T>,
    ) {
        this.left = {action: {type: 'noop'}, run: () => this.step(-1)}
        this.right = {action: {type: 'noop'}, run: () => this.step(1)}
        this.press = {action: {type: 'noop'}, run: () => this.confirm()}
    }

    /** The option now showing, or undefined when the list is empty. */
    get selected(): T | undefined {
        return this.options[this.index]
    }

    detail(): string {
        return this.selected?.label ?? '--'
    }

    /** Move the pick by one, wrapping around, and ask for a repaint. */
    private step(delta: number): void {
        const count = this.options.length
        if (count === 0) return
        this.index = ((this.index + delta) % count + count) % count
        this.handlers.onChange()
    }

    private confirm(): void {
        const option = this.selected
        if (option) this.handlers.onConfirm(option)
    }
}
