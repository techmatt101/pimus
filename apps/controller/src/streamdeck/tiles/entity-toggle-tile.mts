// The general Home Assistant on/off key: the ceiling fan, the blinds, the desk
// PC. All three are the same key — press to flip, face shows what the entity
// actually reports — differing only in their icon and colours, so they are one
// class configured three ways in the layout rather than three near-identical
// files.
//
// The service is derived from the entity's own domain (actions/catalog.mts), so
// `fan.office_ceiling` is toggled by `fan.toggle` and `cover.office_blinds` by
// `cover.toggle` without the layout naming a service.
//
// Given the shared dial (streamdeck/dynamic-dial.mts), a press also hands it
// this entity, so the same three keys that flip the fan, blinds, and lights are
// how you pick which of them the dial is turning.

import { requireEntity } from '../../actions/catalog.mjs'
import { isEntityOn } from '../../home-assistant/entity.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { entityDial, type DialControl, type DynamicDial } from '../dynamic-dial.mjs'
import { withAlpha, type Surface } from '../surface.mjs'
import {
  drawBackground,
  drawCaption,
  drawLabelFace,
  FACE_CENTER,
  type Tile,
  type TileContext,
  type TileHost,
} from './tile.mjs'
import type { IconName } from '../icon-set.mjs'
import type { Action, HomeAssistantEntity, HomeAssistantService } from '../../types.mjs'

export interface EntityToggleTileConfig {
  label: string
  entity: string
  icon: IconName
  /** Background while the entity reports on. */
  onColor?: string
  /** Background while it reports off. */
  offColor?: string
  /**
   * Turns clockwise to draw the icon at, for a device whose icon should be
   * moving while it runs — the ceiling fan. Derive it from `now` and give an
   * `animationMilliseconds` to keep it turning.
   */
  spin?(entity: HomeAssistantEntity | undefined, now: number): number
  /**
   * A 0..1 reading to show as a bar under the icon, for a device that is not
   * merely on or off: how far the blinds are down, how bright the lights are.
   * Return undefined when the entity reports no such reading.
   */
  level?(entity: HomeAssistantEntity | undefined): number | undefined
  /** Repaint interval while the entity is on, for an animated icon. */
  animationMilliseconds?: number
  /**
   * The shared dial this key hands its entity to when pressed. Omit it for a
   * key with nothing to turn; a domain the dial cannot express — a switch —
   * claims nothing even when one is given.
   */
  dial?: DynamicDial
}

/** The unknown-state appearance, shared so every Home Assistant key reads alike. */
const UNKNOWN_COLOR = '#1a1a1a'
const UNKNOWN_ICON = '#424242'

/** The stripe marking the key that currently holds the dial. */
const HOLDING_COLOR = '#26c6da'
const HOLDING_HEIGHT = 4

const ICON_SIZE = 54
/** The level bar sits between the icon and the caption bar. */
const LEVEL_Y = 78
const LEVEL_WIDTH = 64
const LEVEL_HEIGHT = 5

export class EntityToggleTile implements Tile {
  private readonly ha: HomeAssistantService
  private readonly config: EntityToggleTileConfig
  private readonly entity: string
  private readonly toggle: Binding
  private readonly dial: DynamicDial | undefined
  private readonly control: DialControl | undefined
  private host: TileHost | null = null
  private unwatch: (() => void) | null = null
  private animation: NodeJS.Timeout | null = null

  constructor(services: TileServices, config: EntityToggleTileConfig) {
    this.ha = services.ha
    this.config = config
    this.entity = requireEntity(config.entity, `${config.label} tile`)
    this.toggle = createBindings(services).ha('toggle', this.entity)
    this.dial = config.dial
    this.control = config.dial ? entityDial(services, config.label, this.entity) : undefined
  }

  action(): Action {
    return this.toggle.action
  }

  press(): unknown {
    // Claim first: the strip then shows what this key controls as it flips,
    // rather than a beat later.
    if (this.control) this.dial?.claim(this.control)
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

  draw(surface: Surface, { now }: TileContext): void {
    const { label, icon, onColor = '#1b5e20', offColor = '#12281a' } = this.config
    const entity = this.ha.entity(this.entity)
    const on = isEntityOn(entity)
    const spin = this.config.spin?.(entity, now) ?? 0
    const x = surface.width / 2

    if (on === undefined) {
      drawLabelFace(surface, UNKNOWN_COLOR, `${label} ?`)
      surface.icon(icon, { x, y: FACE_CENTER, size: ICON_SIZE, color: UNKNOWN_ICON, rotate: spin })
      this.drawHolding(surface)
      return
    }

    // Painted in layers rather than through drawLabelFace: the glow has to go
    // over the background but under the caption bar, or it washes the label.
    drawBackground(surface, on ? onColor : offColor)
    // A lit key gets a glow behind its icon, so on and off differ by more than
    // a shade of the same background when glanced at from across the room.
    if (on) {
      surface.fill(surface.radialGradient(x, FACE_CENTER, 58, withAlpha('#ffffff', 0.16), withAlpha('#ffffff', 0)))
    }
    surface.icon(icon, {
      x,
      y: FACE_CENTER,
      size: ICON_SIZE,
      color: on ? '#ffffff' : '#607d8b',
      rotate: spin,
    })

    const level = this.config.level?.(entity)
    if (level !== undefined) {
      surface.bar(level, {
        x: x - LEVEL_WIDTH / 2,
        y: LEVEL_Y,
        width: LEVEL_WIDTH,
        height: LEVEL_HEIGHT,
        color: on ? '#ffffff' : '#546e7a',
        track: withAlpha('#000000', 0.45),
        rounded: true,
      })
    }

    drawCaption(surface, `${label} ${on ? 'ON' : 'OFF'}`)
    this.drawHolding(surface)
  }

  /**
   * A stripe along the top of the key holding the dial, in the same colour the
   * dial's own bar is drawn in, so you can see which of three keys the knob is
   * about to move without turning it to find out.
   */
  private drawHolding(surface: Surface): void {
    if (!this.control || !this.dial?.holds(this.control)) return
    surface.ctx.fillStyle = HOLDING_COLOR
    surface.ctx.fillRect(0, 0, surface.width, HOLDING_HEIGHT)
  }
}
