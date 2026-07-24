// A countdown driven by a Home Assistant `timer` entity, so the same timer is
// visible on the deck, in the app, and to anything else in the house — unlike
// the Assist timers LVA rings, which live only inside the voice pipeline.
//
// Home Assistant does not tick: a running timer reports `finishes_at` once and
// then says nothing until it is paused, cancelled, or fires. The countdown here
// is therefore derived from `finishes_at` against the injected `clock` (real
// wall-clock time, not the draw's deltaTime), with the tile running its own
// one-second repaint while the timer is active.

import {requireEntity} from '../../actions/catalog.mjs'
import {durationSeconds, formatDuration, timerRemainingSeconds} from '../../home-assistant/entity.mjs'
import {type Binding, createBindings, type TileServices} from '../bindings.mjs'
import {type Surface, text} from '../surface.mjs'
import {drawBackground, drawCaption, drawValue, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {Action, HomeAssistantService} from '../../types.mjs'

/** How often a running countdown repaints. */
const TICK_MILLISECONDS = 500

/** The ring's radius, which is what leaves the reading room inside it. */
const RING_RADIUS = 40
const RING_WIDTH = 5

export interface TimerTileConfig {
    /** The `timer.` entity this key starts, cancels, and counts down. */
    entity: string
    label?: string
    /** How long a press starts the timer for, as `HH:MM:SS`. */
    duration?: string
}

export class TimerTile implements Tile {
    readonly #ha: HomeAssistantService
    readonly #clock: () => number
    readonly #entity: string
    readonly #label: string
    readonly #toggle: Binding
    #host: TileHost | null = null
    #unwatch: (() => void) | null = null
    #tick: NodeJS.Timeout | null = null

    constructor(services: TileServices, {entity, label = 'TIMER', duration = '00:05:00'}: TimerTileConfig) {
        this.#ha = services.ha
        this.#clock = services.clock
        this.#entity = requireEntity(entity, 'timer tile')
        this.#label = label
        this.#toggle = createBindings(services).ha('timer_toggle', this.#entity, {duration})
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

    /** Tick only while the timer is running; a paused one holds its reading. */
    #followTimer(): void {
        if (this.#ha.entity(this.#entity)?.state === 'active') this.#startTick()
        else this.#stopTick()
    }

    #startTick(): void {
        if (this.#tick) return
        this.#tick = setInterval(() => this.#host?.invalidate(), TICK_MILLISECONDS)
        // A countdown must not keep the daemon alive on shutdown.
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
            text(surface, '--', {x, y: FACE_CENTER, size: 34, color: '#616161'})
            drawCaption(surface, this.#label)
            return
        }

        const active = timer.state === 'active'
        const paused = timer.state === 'paused'
        const remaining = timerRemainingSeconds(timer, now)
        drawBackground(surface, active ? '#3e2000' : paused ? '#2a2410' : '#1c1c1c')

        // The ring empties as the countdown runs, so the key is readable at a
        // glance without reading the digits.
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
