// Skipping goes through the Music Assistant player rather than LVA: the LVA
// media player is the satellite's own announcement player and has no queue.
// Play/pause stays on LVA, which is where the controller's playback state
// comes from.

import {type Binding, haBinding, voiceBinding} from '../bindings.mjs'
import type {Dial} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantService, LvaSender} from '../../types.mjs'

export interface MediaDialConfig {
    player: string
    label?: string
}

export class MediaDial implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #model: ControlModel

    constructor(ha: HomeAssistantService, lva: LvaSender, model: ControlModel, {player, label = 'MEDIA'}: MediaDialConfig) {
        this.#model = model
        this.label = label
        this.left = haBinding(ha, 'media_previous', player)
        this.right = haBinding(ha, 'media_next', player)
        this.press = voiceBinding(lva, model, 'media_toggle')
    }

    detail(): string {
        return this.#model.state.media ? 'PLAYING' : 'PAUSED'
    }
}
