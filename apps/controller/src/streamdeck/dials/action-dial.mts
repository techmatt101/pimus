import type {Binding} from '../bindings.mjs'
import type {Dial} from '../dial.mjs'

export interface ActionDialConfig {
    label: string
    left?: Binding
    right?: Binding
    press?: Binding
    /** The value line: a fixed string, or one worked out at read time. */
    readout: string | (() => string)

    /** The reading as a 0-1 fraction, for a value that is a level. */
    level?(): number | undefined
}

/** The default dial: a fixed name, up to three bindings, and a readout it is told. */
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
