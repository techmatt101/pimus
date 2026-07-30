import type {Binding} from '../bindings.mjs'
import {drawIcon, drawText, type Surface} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {Action} from '../../types.mjs'

const ARM_MILLISECONDS = 5_000
const TICK_MILLISECONDS = 100

const RING_RADIUS = 38
const RING_WIDTH = 5

const IDLE_BACKGROUND = '#263238'
const ARMED_BACKGROUND = '#b71c1c'
const HALTING_BACKGROUND = '#4a0000'
const ARMED_ACCENT = '#ff8a80'

export interface ShutdownTileConfig {
    label?: string
    armMilliseconds?: number
}

/**
 * Halting takes two presses: the first arms the key and starts a ring draining
 * back to disarmed, the second confirms. Nothing on the network can wake the
 * board again, so a single stray press must not be enough.
 */
export class ShutdownTile implements Tile {
    readonly #binding: Binding
    readonly #clock: () => number
    readonly #label: string
    readonly #armWindow: number
    #armedAt: number | null = null
    #halting = false
    #host: TileHost | null = null
    #tick: NodeJS.Timeout | null = null

    constructor(
        binding: Binding,
        clock: () => number,
        {label = 'SHUTDOWN', armMilliseconds = ARM_MILLISECONDS}: ShutdownTileConfig = {},
    ) {
        this.#binding = binding
        this.#clock = clock
        this.#label = label
        this.#armWindow = armMilliseconds
    }

    action(): Action {
        return this.#binding.action
    }

    press(): void {
        if (this.#halting) return
        if (this.#remaining() > 0) {
            this.#disarm()
            this.#halting = true
            this.#binding.run()
        } else {
            this.#armedAt = this.#clock()
            this.#startTick()
        }
        this.#host?.invalidate()
    }

    mount(host: TileHost): void {
        this.#host = host
    }

    unmount(): void {
        this.#disarm()
        this.#host = null
    }

    #remaining(): number {
        if (this.#armedAt === null) return 0
        return Math.max(0, this.#armWindow - (this.#clock() - this.#armedAt))
    }

    #startTick(): void {
        if (this.#tick) return
        this.#tick = setInterval(() => {
            if (this.#remaining() <= 0) this.#disarm()
            this.#host?.invalidate()
        }, TICK_MILLISECONDS)
        this.#tick.unref()
    }

    #disarm(): void {
        this.#armedAt = null
        if (this.#tick) clearInterval(this.#tick)
        this.#tick = null
    }

    draw(surface: Surface): void {
        const x = surface.width / 2

        if (this.#halting) {
            drawBackground(surface, HALTING_BACKGROUND)
            drawIcon(surface, 'power', {x, y: FACE_CENTER, size: 44, color: ARMED_ACCENT, opacity: 0.7})
            drawCaption(surface, 'HALTING')
            return
        }

        const remaining = this.#remaining()
        if (remaining <= 0) {
            drawBackground(surface, IDLE_BACKGROUND)
            drawIcon(surface, 'power', {x, y: FACE_CENTER, size: 44, color: '#b0bec5'})
            drawCaption(surface, this.#label)
            return
        }

        drawBackground(surface, ARMED_BACKGROUND)
        drawRing(surface, x, remaining / this.#armWindow)
        drawIcon(surface, 'power', {x, y: FACE_CENTER, size: 38, color: '#ffffff'})
        drawText(surface, String(Math.ceil(remaining / 1000)), {x, y: FACE_CENTER + 27, size: 18})
        drawCaption(surface, 'CONFIRM?')
        drawActiveGlow(surface, '#ff5252')
    }
}

/** The arming window draining away, clockwise from twelve o'clock as the timer's ring runs. */
function drawRing(surface: Surface, x: number, fraction: number): void {
    const {ctx} = surface
    ctx.save()
    ctx.strokeStyle = ARMED_ACCENT
    ctx.lineWidth = RING_WIDTH
    ctx.lineCap = 'round'
    ctx.beginPath()
    const start = -Math.PI / 2
    ctx.arc(x, FACE_CENTER, RING_RADIUS, start, start + fraction * 2 * Math.PI)
    ctx.stroke()
    ctx.restore()
}
