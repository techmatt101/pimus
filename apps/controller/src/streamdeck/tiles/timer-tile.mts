// A countdown driven by a Home Assistant `timer` entity, so the same timer is
// visible on the deck, in the app, and to anything else in the house — unlike
// the Assist timers LVA rings, which live only inside the voice pipeline.
//
// Home Assistant does not tick: a running timer reports `finishes_at` once and
// then says nothing until it is paused, cancelled, or fires. The countdown here
// is therefore derived from `finishes_at` against `context.now`, with the tile
// running its own one-second repaint while the timer is active.

import { requireEntity } from '../../actions/catalog.mjs'
import { durationSeconds, formatDuration, timerRemainingSeconds } from '../../home-assistant/entity.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { createImage, drawCircle, drawText } from '../bitmap.mjs'
import { drawCaption, type Tile, type TileContext, type TileHost } from './tile.mjs'
import type { Action, Bitmap, HomeAssistantService } from '../../types.mjs'

/** How often a running countdown repaints. */
const TICK_MILLISECONDS = 500

export interface TimerTileConfig {
  /** The `timer.` entity this key starts, cancels, and counts down. */
  entity: string
  label?: string
  /** How long a press starts the timer for, as `HH:MM:SS`. */
  duration?: string
}

export class TimerTile implements Tile {
  private readonly ha: HomeAssistantService
  private readonly entity: string
  private readonly label: string
  private readonly toggle: Binding
  private host: TileHost | null = null
  private unwatch: (() => void) | null = null
  private tick: NodeJS.Timeout | null = null

  constructor(services: TileServices, { entity, label = 'TIMER', duration = '00:05:00' }: TimerTileConfig) {
    this.ha = services.ha
    this.entity = requireEntity(entity, 'timer tile')
    this.label = label
    this.toggle = createBindings(services).ha('timer_toggle', this.entity, { duration })
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
      this.followTimer()
      host.invalidate()
    })
    this.followTimer()
  }

  unmount(): void {
    this.unwatch?.()
    this.unwatch = null
    this.stopTick()
    this.host = null
  }

  /** Tick only while the timer is running; a paused one holds its reading. */
  private followTimer(): void {
    if (this.ha.entity(this.entity)?.state === 'active') this.startTick()
    else this.stopTick()
  }

  private startTick(): void {
    if (this.tick) return
    this.tick = setInterval(() => this.host?.invalidate(), TICK_MILLISECONDS)
    // A countdown must not keep the daemon alive on shutdown.
    this.tick.unref()
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
  }

  render({ now }: TileContext): Bitmap {
    const timer = this.ha.entity(this.entity)
    if (!timer) {
      const unknown = createImage(120, 120, '#1a1a1a')
      drawCircle(unknown, 60, 46, 42, '#424242', { thickness: 4 })
      drawText(unknown, '--', 60, 46, 3, '#616161')
      drawCaption(unknown, this.label)
      return unknown
    }

    const active = timer.state === 'active'
    const paused = timer.state === 'paused'
    const remaining = timerRemainingSeconds(timer, now)
    const face = createImage(120, 120, active ? '#3e2000' : paused ? '#2a2410' : '#1c1c1c')

    // The ring empties as the countdown runs, so the key is readable at a
    // glance without reading the digits. Radius 42 is what leaves the reading
    // room inside the ring rather than drawn across it.
    drawCircle(face, 60, 46, 42, '#4e342e', { thickness: 4 })
    if (active || paused) {
      const total = durationSeconds(timer.attributes.duration)
      const fraction = total && remaining !== undefined ? Math.min(1, remaining / total) : 0
      drawCircle(face, 60, 46, 42, active ? '#ff9100' : '#ffd54f', { thickness: 4, to: fraction })
    }

    const reading = active || paused ? formatDuration(remaining ?? 0) : 'SET'
    drawText(face, reading, 60, 46, reading.length > 3 ? 3 : 4)
    drawCaption(face, paused ? `${this.label} HELD` : this.label)
    return face
  }
}
