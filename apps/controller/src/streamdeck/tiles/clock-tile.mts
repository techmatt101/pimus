// The time of day, with a bar that sweeps once a minute. The only tile that
// needs nothing but the clock, so it works on a deck with no Home Assistant and
// no voice assistant configured.
//
// Its repaint is scheduled to the next second boundary rather than on a plain
// one-second interval, so the bar steps in time with the wall clock instead of
// drifting a little further from it every minute the deck stays on one page.

import { bar, fittingSize, text, type Surface } from '../surface.mjs'
import type { TileServices } from '../bindings.mjs'
import { drawBackground, drawCaption, type Tile, type TileHost } from './tile.mjs'

export interface ClockTileConfig {
  /** Show a 24-hour clock; the caption carries the date either way. */
  hours24?: boolean
  color?: string
}

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** The face's two lines at an instant, in the machine's local timezone. */
export function clockFace(now: number, hours24: boolean): { time: string; date: string } {
  const at = new Date(now)
  const hours = hours24 ? at.getHours() : at.getHours() % 12 || 12
  const time = `${hours24 ? String(hours).padStart(2, '0') : hours}:${String(at.getMinutes()).padStart(2, '0')}`
  return { time, date: `${DAYS[at.getDay()] ?? ''} ${at.getDate()}` }
}

export class ClockTile implements Tile {
  private readonly clock: () => number
  private readonly hours24: boolean
  private readonly color: string
  private host: TileHost | null = null
  private tick: NodeJS.Timeout | null = null

  constructor(services: TileServices, { hours24 = true, color = '#101820' }: ClockTileConfig = {}) {
    this.clock = services.clock
    this.hours24 = hours24
    this.color = color
  }

  press(): void {}

  mount(host: TileHost): void {
    this.host = host
    this.scheduleTick()
  }

  unmount(): void {
    if (this.tick) clearTimeout(this.tick)
    this.tick = null
    this.host = null
  }

  /** Repaint on the next whole second, then keep re-arming from there. */
  private scheduleTick(): void {
    this.tick = setTimeout(() => {
      this.host?.invalidate()
      this.scheduleTick()
    }, 1000 - (this.clock() % 1000))
    // A clock must not keep the daemon alive on shutdown.
    this.tick.unref()
  }

  draw(surface: Surface): void {
    const now = this.clock()
    const { time, date } = clockFace(now, this.hours24)
    drawBackground(surface, this.color)
    text(surface, time, { x: surface.width / 2, y: 40, size: fittingSize(time, [56, 46], 104) })

    // A bar rather than a ring: a five-character time fills the key too widely
    // to sit inside one without the digits crossing it.
    const seconds = new Date(now).getSeconds()
    bar(surface, (seconds + 1) / 60, {
      x: 18,
      y: 68,
      width: 84,
      height: 6,
      color: '#4dd0e1',
      track: '#1c2b36',
      rounded: true,
    })

    drawCaption(surface, date)
  }
}
