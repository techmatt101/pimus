// The general Home Assistant on/off key: the ceiling fan, the blinds, the desk
// PC. All three are the same key — press to flip, face shows what the entity
// actually reports — differing only in their icon and colours, so they are one
// class configured three ways in the layout rather than three near-identical
// files.
//
// The service is derived from the entity's own domain (actions/catalog.mts), so
// `fan.office_ceiling` is toggled by `fan.toggle` and `cover.office_blinds` by
// `cover.toggle` without the layout naming a service.

import { requireEntity } from '../../actions/catalog.mjs'
import { isEntityOn } from '../../home-assistant/entity.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import type { Icon } from '../icons.mjs'
import { labelTile, type Tile, type TileContext, type TileHost } from './tile.mjs'
import type { Action, Bitmap, HomeAssistantEntity, HomeAssistantService } from '../../types.mjs'

export interface EntityToggleTileConfig {
  label: string
  entity: string
  icon: Icon
  /** Background while the entity reports on. */
  onColor?: string
  /** Background while it reports off. */
  offColor?: string
  /**
   * The 0..1 appearance phase handed to the icon. Give a time-varying value and
   * an `animationMilliseconds` to animate — the fan turns its blades — or a
   * state-derived constant, as the blinds do to draw their slats down.
   */
  phase?(entity: HomeAssistantEntity | undefined, now: number): number
  /** Repaint interval while the entity is on, for an animated icon. */
  animationMilliseconds?: number
}

/** The unknown-state appearance, shared so every Home Assistant key reads alike. */
const UNKNOWN_COLOR = '#1a1a1a'
const UNKNOWN_ICON = '#424242'

export class EntityToggleTile implements Tile {
  private readonly ha: HomeAssistantService
  private readonly config: EntityToggleTileConfig
  private readonly entity: string
  private readonly toggle: Binding
  private host: TileHost | null = null
  private unwatch: (() => void) | null = null
  private animation: NodeJS.Timeout | null = null

  constructor(services: TileServices, config: EntityToggleTileConfig) {
    this.ha = services.ha
    this.config = config
    this.entity = requireEntity(config.entity, `${config.label} tile`)
    this.toggle = createBindings(services).ha('toggle', this.entity)
  }

  action(): Action {
    return this.toggle.action
  }

  press(): unknown {
    return this.toggle.run()
  }

  mount(host: TileHost): void {
    this.host = host
    this.unwatch = this.ha.watch([this.entity], () => {
      this.followState()
      host.invalidate()
    })
    this.followState()
  }

  unmount(): void {
    this.unwatch?.()
    this.unwatch = null
    this.stopAnimation()
    this.host = null
  }

  /** Animate only while the entity is on: a stopped fan has nothing to turn. */
  private followState(): void {
    if (this.config.animationMilliseconds && isEntityOn(this.ha.entity(this.entity))) {
      this.startAnimation(this.config.animationMilliseconds)
    } else {
      this.stopAnimation()
    }
  }

  private startAnimation(interval: number): void {
    if (this.animation) return
    this.animation = setInterval(() => this.host?.invalidate(), interval)
    // An animation must not keep the daemon alive on shutdown.
    this.animation.unref()
  }

  private stopAnimation(): void {
    if (this.animation) clearInterval(this.animation)
    this.animation = null
  }

  render({ now }: TileContext): Bitmap {
    const { label, icon, onColor = '#1b5e20', offColor = '#12281a' } = this.config
    const entity = this.ha.entity(this.entity)
    const on = isEntityOn(entity)
    const phase = this.config.phase?.(entity, now) ?? 0

    if (on === undefined) {
      const unknown = labelTile(UNKNOWN_COLOR, `${label} ?`)
      icon(unknown, 60, 44, UNKNOWN_ICON, phase)
      return unknown
    }

    const face = labelTile(on ? onColor : offColor, `${label} ${on ? 'ON' : 'OFF'}`)
    icon(face, 60, 44, on ? '#ffffff' : '#607d8b', phase)
    return face
  }
}
