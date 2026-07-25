// All transport goes through the Music Assistant player, not LVA: the LVA media
// player is the satellite's own announcement player, with no queue to skip and
// no bearing on what the speakers are playing.

import {type Binding, haBinding} from '../bindings.mjs'
import type {Dial} from '../dial.mjs'
import type {HomeAssistantService} from '../../types.mjs'

export interface MediaDialConfig {
    player: string
    label?: string
}

export class MediaDial implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #ha: HomeAssistantService
    readonly #player: string

    constructor(ha: HomeAssistantService, {player, label = 'MEDIA'}: MediaDialConfig) {
        this.#ha = ha
        this.#player = player
        this.label = label
        this.left = haBinding(ha, 'media_previous', player)
        this.right = haBinding(ha, 'media_next', player)
        this.press = haBinding(ha, 'media_play_pause', player)
    }

    detail(): string {
        return this.#ha.entity(this.#player)?.state === 'playing' ? 'PLAYING' : 'PAUSED'
    }
}
