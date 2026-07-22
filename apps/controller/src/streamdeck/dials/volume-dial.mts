// Master output volume, the one dial that never changes hands. It reads the
// controller's own state rather than Home Assistant: the volume it moves is the
// amplifier's, applied by the audio manager, so it is right even with nothing
// else on the network reachable.
//
// Muted is its own reading, not a volume of zero — the level you will come back
// to when you unmute is still the level the deck remembers.

import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { percent, type Dial } from './dial.mjs'
import type { TileContext } from '../tiles/tile.mjs'

export class VolumeDial implements Dial {
  readonly label: string
  readonly left: Binding
  readonly right: Binding
  readonly press: Binding

  constructor(services: TileServices, label = 'VOLUME') {
    const { volume } = createBindings(services)
    this.label = label
    this.left = volume('down')
    this.right = volume('up')
    this.press = volume('mute')
  }

  detail({ state }: TileContext): string {
    return state.outputMuted ? 'MUTED' : percent(state.volume)
  }

  /** A muted bar reads as empty, which is what muted sounds like. */
  level({ state }: TileContext): number {
    return state.outputMuted ? 0 : state.volume
  }
}
