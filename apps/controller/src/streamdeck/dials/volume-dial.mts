// Master output volume, the one dial that never changes hands. It reads the
// controller's own state rather than Home Assistant: the volume it moves is the
// amplifier's, applied by the audio manager, so it is right even with nothing
// else on the network reachable.
//
// Muted is its own reading, not a volume of zero — the level you will come back
// to when you unmute is still the level the deck remembers.

import {type Binding, createBindings, type TileServices} from '../bindings.mjs'
import {type Dial, percent} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'

export class VolumeDial implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #model: ControlModel

    constructor(services: TileServices, label = 'VOLUME') {
        const {volume} = createBindings(services)
        this.#model = services.model
        this.label = label
        this.left = volume('down')
        this.right = volume('up')
        this.press = volume('mute')
    }

    detail(): string {
        const {state} = this.#model
        return state.outputMuted ? 'MUTED' : percent(state.volume)
    }

    /** A muted bar reads as empty, which is what muted sounds like. */
    level(): number {
        const {state} = this.#model
        return state.outputMuted ? 0 : state.volume
    }
}
