import {requireEntity} from '../../actions/catalog.mjs'
import {durationSeconds, formatDuration, timerRemainingSeconds} from '../../home-assistant/entity.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {type Surface, drawText} from '../surface.mjs'
import {drawBackground, drawCaption, drawValue, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {Action, HomeAssistantService} from '../../types.mjs'

const TICK_MILLISECONDS = 500

const RING_RADIUS = 40
const RING_WIDTH = 5

export interface TimerTileConfig {
    entity: string
    label?: string
    /** How long a press starts the timer for, as `HH:MM:SS`. */
    duration?: string
}

/**
 * A countdown driven by a Home Assistant `timer` entity. Home Assistant does
 * not tick — a running timer reports `finishes_at` once — so the countdown is
 * derived from that against the injected clock, with the tile running its own
 * repaint interval while active.
 */
export class TimerTile implements Tile {
    readonly #ha: HomeAssistantService
    readonly #clock: () => number
    readonly #entity: string
    readonly #label: string
    readonly #toggle: Binding
    #host: TileHost | null = null
    #unwatch: (() => void) | null = null
    #tick: NodeJS.Timeout | null = null

    constructor(ha: HomeAssistantService, clock: () => number, {entity, label = 'TIMER', duration = '00:05:00'}: TimerTileConfig) {
        this.#ha = ha
        this.#clock = clock
        this.#entity = requireEntity(entity, 'timer tile')
        this.#label = label
        this.#toggle = haBinding(ha, 'timer_toggle', this.#entity, {duration})
    }

    action(): Action {
        return this.#toggle.action
    }

    press(): void {
        this.#toggle.run()
    }

    mount(host: TileHost): void {
        this.#host = host
        this.#unwatch = this.#ha.watch([this.#entity], () => {
            this.#followTimer()
            host.invalidate()
        })
        this.#followTimer()
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
        this.#stopTick()
        this.#host = null
    }

    #followTimer(): void {
        if (this.#ha.entity(this.#entity)?.state === 'active') this.#startTick()
        else this.#stopTick()
    }

    #startTick(): void {
        if (this.#tick) return
        this.#tick = setInterval(() => this.#host?.invalidate(), TICK_MILLISECONDS)
        this.#tick.unref()
    }

    #stopTick(): void {
        if (this.#tick) clearInterval(this.#tick)
        this.#tick = null
    }

    draw(surface: Surface): void {
        const now = this.#clock()
        const x = surface.width / 2
        const timer = this.#ha.entity(this.#entity)
        if (!timer) {
            drawBackground(surface, '#1a1a1a')
            drawRing(surface, x, 1, '#424242')
            drawText(surface, '--', {x, y: FACE_CENTER, size: 34, color: '#616161'})
            drawCaption(surface, this.#label)
            return
        }

        const active = timer.state === 'active'
        const paused = timer.state === 'paused'
        const remaining = timerRemainingSeconds(timer, now)
        drawBackground(surface, active ? '#3e2000' : paused ? '#2a2410' : '#1c1c1c')

        drawRing(surface, x, 1, '#4e342e')
        if (active || paused) {
            const total = durationSeconds(timer.attributes.duration)
            const fraction = total && remaining !== undefined ? Math.min(1, remaining / total) : 0
            drawRing(surface, x, fraction, active ? '#ff9100' : '#ffd54f')
        }

        const reading = active || paused ? formatDuration(remaining ?? 0) : 'SET'
        drawValue(surface, reading, x, FACE_CENTER, RING_RADIUS * 2 - 12)
        drawCaption(surface, paused ? `${this.#label} HELD` : this.#label)
    }
}

/** The countdown ring, drawn clockwise from twelve o'clock. */
function drawRing(surface: Surface, x: number, fraction: number, color: string): void {
    if (fraction <= 0) return
    const {ctx} = surface
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = RING_WIDTH
    ctx.lineCap = 'round'
    ctx.beginPath()
    const start = -Math.PI / 2
    ctx.arc(x, FACE_CENTER, RING_RADIUS, start, start + Math.min(1, fraction) * 2 * Math.PI)
    ctx.stroke()
    ctx.restore()
}
