// The time of day, with a bar that sweeps once a minute. The only tile that
// needs nothing but the clock, so it works on a deck with no Home Assistant and
// no voice assistant configured.
//
// Its repaint is scheduled to the next second boundary rather than on a plain
// one-second interval, so the bar steps in time with the wall clock instead of
// drifting a little further from it every minute the deck stays on one page.

import { createImage, drawRectangle, drawText } from '../bitmap.mjs'
import { drawCaption, type Tile, type TileContext, type TileHost } from './tile.mjs'
import type { Bitmap } from '../../types.mjs'

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
  private readonly hours24: boolean
  private readonly color: string
  private host: TileHost | null = null
  private tick: NodeJS.Timeout | null = null

  constructor({ hours24 = true, color = '#101820' }: ClockTileConfig = {}) {
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
    }, 1000 - (Date.now() % 1000))
    // A clock must not keep the daemon alive on shutdown.
    this.tick.unref()
  }

  render({ now }: TileContext): Bitmap {
    const { time, date } = clockFace(now, this.hours24)
    const face = createImage(120, 120, this.color)
    drawText(face, time, 60, 40, time.length > 4 ? 3 : 4)

    // A bar rather than a ring: a five-character time fills the key too widely
    // to sit inside one without the digits crossing it.
    const seconds = new Date(now).getSeconds()
    drawRectangle(face, 18, 68, 84, 6, '#1c2b36')
    drawRectangle(face, 18, 68, Math.round((84 * (seconds + 1)) / 60), 6, '#4dd0e1')

    drawCaption(face, date)
    return face
  }
}
