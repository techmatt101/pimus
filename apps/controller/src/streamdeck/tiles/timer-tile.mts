import {requireEntity} from '../../actions/catalog.mjs'
import {durationSeconds, formatDuration, secondsToHms, timerRemainingSeconds} from '../../home-assistant/entity.mjs'
import {ArmedControl} from '../armed-control.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {DurationDial} from '../duration-dial.mjs'
import {type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {Action, HomeAssistantService} from '../../types.mjs'

const TICK_MILLISECONDS = 500

const RING_RADIUS = 40
const RING_WIDTH = 5

// One height for every reading, condensed to the ring rather than resized per
// digit count, so the countdown does not jump between "5:00" and "10:00".
const READING_SIZE = 30
const READING_WIDTH = RING_RADIUS * 2 - 12

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
    readonly #defaultSeconds: number
    readonly #setDial: DurationDial
    readonly #armed: ArmedControl
    #host: TileHost | null = null
    #unwatch: (() => void) | null = null
    #tick: NodeJS.Timeout | null = null

    constructor(ha: HomeAssistantService, clock: () => number, dial: DynamicDial, {entity, label = 'TIMER', duration = '00:05:00'}: TimerTileConfig) {
        this.#ha = ha
        this.#clock = clock
        this.#entity = requireEntity(entity, 'timer tile')
        this.#label = label
        this.#toggle = haBinding(ha, 'timer_toggle', this.#entity, {duration})
        this.#defaultSeconds = durationSeconds(duration) ?? 300
        this.#setDial = new DurationDial(label, this.#defaultSeconds, {
            onConfirm: (seconds) => this.#start(seconds),
            onChange: () => this.#host?.invalidate(),
        })
        this.#armed = new ArmedControl(dial, this.#setDial, () => this.#start(this.#setDial.seconds))
    }

    action(): Action {
        return this.#toggle.action
    }

    press(): void {
        // Running: the press stops it, no setting involved. Idle: the first press
        // arms the dial from a fresh default to set a new length, the next starts.
        if (!this.#armed.armed && this.#running()) {
            this.#toggle.run()
            return
        }
        if (!this.#armed.armed) this.#setDial.reset(this.#defaultSeconds)
        this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    #running(): boolean {
        const state = this.#ha.entity(this.#entity)?.state
        return state === 'active' || state === 'paused'
    }

    #start(seconds: number): void {
        this.#armed.release()
        haBinding(this.#ha, 'timer_toggle', this.#entity, {duration: secondsToHms(seconds)}).run()
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
        this.#armed.release()
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

        // Armed: the timer is idle and the dial is picking its length; show that
        // instead of the entity, with the accent ring full to read as "ready".
        if (this.#armed.armed) {
            drawBackground(surface, '#3e2000')
            drawRing(surface, x, 1, '#4e342e')
            drawRing(surface, x, 1, '#ffab40')
            drawText(surface, formatDuration(this.#setDial.seconds), {x, y: FACE_CENTER, size: READING_SIZE, maxWidth: READING_WIDTH})
            drawCaption(surface, `${this.#label} SET`)
            drawActiveGlow(surface)
            return
        }

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
        drawText(surface, reading, {x, y: FACE_CENTER, size: READING_SIZE, maxWidth: READING_WIDTH})
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
