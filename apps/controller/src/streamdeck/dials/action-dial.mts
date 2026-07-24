// The default dial: a fixed name, up to three bindings, and a readout it is
// told. This is the dial to reach for unless a knob needs a reading it has to
// work out for itself — then write a new Dial class in this folder, exactly as
// a key that outgrows ActionTile becomes its own Tile.
//
// It is also how a knob is held open. A dial with no bindings and a readout
// saying so is honest about being unused; one left to guess would fall back to
// some other dial's reading and look like a dial that has stopped responding.

import type {Binding} from '../bindings.mjs'
import type {Dial} from './dial.mjs'

export interface ActionDialConfig {
    label: string
    left?: Binding
    right?: Binding
    press?: Binding
    /**
     * The value line: a fixed string, or one worked out at read time. A dynamic
     * readout closes over whatever live state it reports on rather than being
     * handed a context.
     */
    readout: string | (() => string)

    /** The reading as a 0-1 fraction, for a value that is a level. */
    level?(): number | undefined
}

export class ActionDial implements Dial {
    readonly label: string
    readonly left: Binding | undefined
    readonly right: Binding | undefined
    readonly press: Binding | undefined
    readonly #readout: string | (() => string)
    readonly #reading: ActionDialConfig['level']

    constructor(config: ActionDialConfig) {
        this.label = config.label
        this.left = config.left
        this.right = config.right
        this.press = config.press
        this.#readout = config.readout
        this.#reading = config.level
    }

    detail(): string {
        return typeof this.#readout === 'function' ? this.#readout() : this.#readout
    }

    level(): number | undefined {
        return this.#reading?.()
    }
}
