import {type Binding, volumeBinding} from '../bindings.mjs'
import {type Dial, percent} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'
import type {AudioControls} from '../../types.mjs'

export class VolumeDial implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #model: ControlModel

    constructor(audio: AudioControls, model: ControlModel, label = 'VOLUME') {
        this.#model = model
        this.label = label
        // wpctl moves the sink in 5% steps, but the real level only returns on the
        // next output poll. Nudge the reading now so the readout tracks each
        // detent; the poll then corrects it to the true value.
        this.left = this.#nudged(volumeBinding(audio, 'down'), -0.05)
        this.right = this.#nudged(volumeBinding(audio, 'up'), 0.05)
        this.press = volumeBinding(audio, 'mute')
    }

    #nudged(binding: Binding, delta: number): Binding {
        return {
            action: binding.action,
            run: () => {
                const {state} = this.#model
                if (!state.outputMuted) {
                    state.volume = Math.max(0, Math.min(1, state.volume + delta))
                    this.#model.notify()
                }
                return binding.run()
            },
        }
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
