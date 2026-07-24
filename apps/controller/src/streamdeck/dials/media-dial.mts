// Transport: skip back, skip forward, and press to play or pause.
//
// Skipping goes through the Music Assistant player rather than LVA, because the
// LVA media player is the satellite's own announcement player and has no queue
// to move through. Play/pause stays on LVA, because that is where the
// controller's own playback state comes from — which is also what this dial
// reads out, so the knob reports the same thing the play key does.

import {type Binding, haBinding, voiceBinding} from '../bindings.mjs'
import type {Dial} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantService, LvaSender} from '../../types.mjs'

export interface MediaDialConfig {
    /** The `media_player.` entity the skips are sent to. */
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
