// Shuffle for the media player, read back from Home Assistant. LVA's media
// player is the satellite's own announcement player and has no queue, so the
// shuffle state lives on the Music Assistant player entity and this key both
// sets and reflects it.

import { requireEntity } from '../../actions/catalog.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { drawLabelFace, FACE_CENTER, type Tile, type TileHost } from './tile.mjs'
import { icon, type Surface } from '../surface.mjs'
import type { Action, HomeAssistantService } from '../../types.mjs'

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

  draw(surface: Surface): void {
    const player = this.ha.entity(this.entity)
    // Unknown is its own appearance: a dim key that says so beats a key
    // confidently claiming shuffle is off because Home Assistant is unreachable.
    if (!player) {
      drawLabelFace(surface, '#1a1a1a', 'SHUFFLE ?')
      this.icon(surface, '#424242')
      return
    }
    const on = Boolean(player.attributes.shuffle)
    drawLabelFace(surface, on ? '#4527a0' : '#1a1329', on ? 'SHUFFLE ON' : 'SHUFFLE')
    this.icon(surface, on ? '#ffffff' : '#7e57c2')
  }

  private icon(surface: Surface, color: string): void {
    icon(surface, 'shuffle', { x: surface.width / 2, y: FACE_CENTER, size: 56, color })
  }
}
