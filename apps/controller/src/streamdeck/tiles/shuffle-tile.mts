// Shuffle for the media player, read back from Home Assistant. LVA's media
// player is the satellite's own announcement player and has no queue, so the
// shuffle state lives on the Music Assistant player entity and this key both
// sets and reflects it.

import { requireEntity } from '../../actions/catalog.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { shuffleIcon } from '../icons.mjs'
import { labelTile, type Tile, type TileHost } from './tile.mjs'
import type { Action, Bitmap, HomeAssistantService } from '../../types.mjs'

export class ShuffleTile implements Tile {
  private readonly ha: HomeAssistantService
  private readonly entity: string
  private readonly toggle: Binding
  private unwatch: (() => void) | null = null

  constructor(services: TileServices, entity: string) {
    this.ha = services.ha
    this.entity = requireEntity(entity, 'shuffle tile')
    this.toggle = createBindings(services).ha('media_shuffle', this.entity)
  }

  action(): Action {
    return this.toggle.action
  }

  press(): unknown {
    return this.toggle.run()
  }

  mount(host: TileHost): void {
    this.unwatch = this.ha.watch([this.entity], () => host.invalidate())
  }

  unmount(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  render(): Bitmap {
    const player = this.ha.entity(this.entity)
    // Unknown is its own appearance: a dim key that says so beats a key
    // confidently claiming shuffle is off because Home Assistant is unreachable.
    if (!player) {
      const unknown = labelTile('#1a1a1a', 'SHUFFLE')
      shuffleIcon(unknown, 60, 46, '#424242')
      return unknown
    }
    const on = Boolean(player.attributes.shuffle)
    const face = labelTile(on ? '#4527a0' : '#1a1329', on ? 'SHUFFLE ON' : 'SHUFFLE')
    shuffleIcon(face, 60, 46, on ? '#ffffff' : '#7e57c2')
    return face
  }
}
