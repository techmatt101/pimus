// Transport: skip back, skip forward, and press to play or pause.
//
// Skipping goes through the Music Assistant player rather than LVA, because the
// LVA media player is the satellite's own announcement player and has no queue
// to move through. Play/pause stays on LVA, because that is where the
// controller's own playback state comes from — which is also what this dial
// reads out, so the knob reports the same thing the play key does.

import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import type { Dial } from './dial.mjs'
import type { TileContext } from '../tiles/tile.mjs'

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

  constructor(services: TileServices, { player, label = 'MEDIA' }: MediaDialConfig) {
    const { ha, voice } = createBindings(services)
    this.label = label
    this.left = ha('media_previous', player)
    this.right = ha('media_next', player)
    this.press = voice('media_toggle')
  }

  detail({ state }: TileContext): string {
    return state.media ? 'PLAYING' : 'PAUSED'
  }
}
