// The time of day. The only tile that needs nothing injected at all: it reads
// its own wall clock, so it works on a deck with no Home Assistant and no voice
// assistant configured.
//
// The face changes only once a minute, so its repaint is scheduled to the next
// minute boundary rather than ticking every second — the key redraws when the
// digits actually change and stays idle the rest of the minute.

import {fittingSize, type Surface, text} from '../surface.mjs'
import {drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'

export interface ClockTileConfig {
    /** Show a 24-hour clock; the caption carries the date either way. */
    hours24?: boolean
    color?: string
}

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

const MINUTE = 60_000

/** The face's two lines at an instant, in the machine's local timezone. */
export function clockFace(now: number, hours24: boolean): { time: string; date: string } {
    const at = new Date(now)
    const hours = hours24 ? at.getHours() : at.getHours() % 12 || 12
    const time = `${hours24 ? String(hours).padStart(2, '0') : hours}:${String(at.getMinutes()).padStart(2, '0')}`
    return {time, date: `${DAYS[at.getDay()] ?? ''} ${at.getDate()}`}
}

export class ClockTile implements Tile {
    private readonly hours24: boolean
    private readonly color: string
    private host: TileHost | null = null
    private tick: NodeJS.Timeout | null = null

    constructor({hours24 = true, color = '#101820'}: ClockTileConfig = {}) {
        this.hours24 = hours24
        this.color = color
    }

    press(): void {
    }

    mount(host: TileHost): void {
        this.host = host
        this.scheduleTick()
    }

    unmount(): void {
        if (this.tick) clearTimeout(this.tick)
        this.tick = null
        this.host = null
    }

    /** Repaint on the next minute boundary, then keep re-arming from there. */
    private scheduleTick(): void {
        this.tick = setTimeout(() => {
            this.host?.invalidate()
            this.scheduleTick()
        }, MINUTE - (Date.now() % MINUTE))
        // A clock must not keep the daemon alive on shutdown.
        this.tick.unref()
    }

    draw(surface: Surface): void {
        const {time, date} = clockFace(Date.now(), this.hours24)
        drawBackground(surface, this.color)
        text(surface, time, {x: surface.width / 2, y: FACE_CENTER, size: fittingSize(time, [56, 46], 104)})
        drawCaption(surface, date)
    }
}
