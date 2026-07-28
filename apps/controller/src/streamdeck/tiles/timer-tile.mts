import {requireEntity} from '../../actions/catalog.mjs'
import {formatDuration} from '../../home-assistant/entity.mjs'
import {ArmedControl} from '../armed-control.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {DurationDial} from '../duration-dial.mjs'
import {type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {ControlModel, Unsubscribe} from '../../state.mjs'
import type {Action, HomeAssistantService, LvaSender, TimerState} from '../../types.mjs'

const TICK_MILLISECONDS = 500

const RING_RADIUS = 40
const RING_WIDTH = 5

// One height for every reading, condensed to the ring rather than resized per
// digit count, so the countdown does not jump between "5:00" and "10:00".
const READING_SIZE = 30
const READING_WIDTH = RING_RADIUS * 2 - 12

export interface TimerTileConfig {
    /** The satellite whose assistant timers this key owns. */
    satellite: string
    label?: string
    /** How long a press starts the timer for, as seconds. */
    duration?: number
}

/**
 * The amp's assistant timer, however it was set: "set a timer for five minutes"
 * and this key produce the same timer on the same device. The countdown comes
 * from the voice socket, which reports a reading rather than ticking, so the
 * tile derives the rest against the injected clock and runs its own repaint.
 */
export class TimerTile implements Tile {
    readonly #model: ControlModel
    readonly #clock: () => number
    readonly #lva: LvaSender
    readonly #label: string
    readonly #ha: HomeAssistantService
    readonly #device: string
    readonly #cancel: Binding
    readonly #resume: Binding
    readonly #defaultSeconds: number
    readonly #setDial: DurationDial
    readonly #armed: ArmedControl
    #host: TileHost | null = null
    #unsubscribe: Unsubscribe | null = null
    #tick: NodeJS.Timeout | null = null

    constructor(
        model: ControlModel,
        ha: HomeAssistantService,
        lva: LvaSender,
        clock: () => number,
        dial: DynamicDial,
        {satellite, label = 'TIMER', duration = 300}: TimerTileConfig,
    ) {
        this.#model = model
        this.#clock = clock
        this.#lva = lva
        this.#label = label
        this.#ha = ha
        this.#device = requireEntity(satellite, 'timer tile')
        this.#cancel = haBinding(ha, 'timer_cancel', this.#device)
        this.#resume = haBinding(ha, 'timer_resume', this.#device)
        this.#defaultSeconds = duration
        this.#setDial = new DurationDial(label, duration, {
            onConfirm: (seconds) => this.#startTimer(seconds),
            onChange: () => this.#host?.invalidate(),
        })
        this.#armed = new ArmedControl(dial, this.#setDial, () => this.#startTimer(this.#setDial.seconds))
    }

    action(): Action {
        return {type: 'ha', command: 'timer_start', entity: this.#device}
    }

    press(): void {
        // A live timer always wins the press, even over a dial armed to set a
        // new one, because it can arrive by voice while the knob is out.
        const timer = this.#timer()
        if (timer) {
            this.#armed.release()
            // Ringing is silenced here rather than through Home Assistant, so
            // the room goes quiet on the press and not a round trip later.
            if (timer.ringing) this.#lva.send('stop_timer_ringing')
            else if (timer.active) this.#cancel.run()
            else this.#resume.run()
            return
        }
        if (!this.#armed.armed) this.#setDial.reset(this.#defaultSeconds)
        this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    #timer(): TimerState | null {
        return this.#model.state.timer
    }

    #remainingSeconds(timer: TimerState): number {
        if (!timer.active) return timer.secondsLeft
        return Math.max(0, (timer.endsAt - this.#clock()) / 1000)
    }

    #startTimer(seconds: number): void {
        this.#armed.release()
        if (seconds <= 0) return
        haBinding(this.#ha, 'timer_start', this.#device, timerSlots(seconds)).run()
    }

    mount(host: TileHost): void {
        this.#host = host
        this.#unsubscribe = this.#model.subscribe(() => {
            this.#followTimer()
            host.invalidate()
        })
        this.#followTimer()
    }

    unmount(): void {
        this.#unsubscribe?.()
        this.#unsubscribe = null
        this.#stopTick()
        this.#armed.release()
        this.#host = null
    }

    #followTimer(): void {
        const timer = this.#timer()
        if (timer && timer.active && !timer.ringing) this.#startTick()
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
        const x = surface.width / 2

        // Armed: no timer is running and the dial is picking a length; show that
        // instead of the countdown, with the accent ring full to read as "ready".
        if (this.#armed.armed) {
            drawBackground(surface, '#3e2000')
            drawRing(surface, x, 1, '#4e342e')
            drawRing(surface, x, 1, '#ffab40')
            drawText(surface, formatDuration(this.#setDial.seconds), {x, y: FACE_CENTER, size: READING_SIZE, maxWidth: READING_WIDTH})
            drawCaption(surface, `${this.#label} SET`)
            drawActiveGlow(surface)
            return
        }

        const timer = this.#timer()
        if (!timer) {
            drawBackground(surface, '#1c1c1c')
            drawRing(surface, x, 1, '#4e342e')
            drawText(surface, 'SET', {x, y: FACE_CENTER, size: READING_SIZE, maxWidth: READING_WIDTH})
            drawCaption(surface, this.#label)
            return
        }

        const remaining = this.#remainingSeconds(timer)
        drawBackground(surface, timer.ringing ? '#b71c1c' : timer.active ? '#3e2000' : '#2a2410')
        drawRing(surface, x, 1, '#4e342e')
        const fraction = timer.totalSeconds > 0 ? Math.min(1, remaining / timer.totalSeconds) : 0
        drawRing(surface, x, timer.ringing ? 1 : fraction, timer.ringing ? '#ff8a80' : timer.active ? '#ff9100' : '#ffd54f')

        drawText(surface, timer.ringing ? 'STOP' : formatDuration(remaining), {x, y: FACE_CENTER, size: READING_SIZE, maxWidth: READING_WIDTH})
        drawCaption(surface, this.#caption(timer))
        if (timer.ringing) drawActiveGlow(surface)
    }

    #caption(timer: TimerState): string {
        if (timer.ringing) return timer.name || this.#label
        if (!timer.active) return `${this.#label} HELD`
        return timer.name || this.#label
    }
}

// HassStartTimer wants at least one of hours, minutes, and seconds, and reads
// them as a sum; the dial's ceiling is under an hour.
function timerSlots(seconds: number): Record<string, number> {
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    if (!minutes) return {seconds: remainder}
    return remainder ? {minutes, seconds: remainder} : {minutes}
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
