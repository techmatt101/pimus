import {ArmedControl} from '../armed-control.mjs'
import {panelBinding} from '../bindings.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import type {IconName} from '../icon-set.mjs'
import {SelectionDial, type SelectionOption} from '../selection-dial.mjs'
import {drawIcon, drawText, type Surface} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, drawDots, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {PanelActionName} from '../../actions/catalog.mjs'
import type {PowerControls} from '../../types.mjs'

const ARM_MILLISECONDS = 5_000
const TICK_MILLISECONDS = 100

const RING_RADIUS = 38
const RING_WIDTH = 5

const TITLE = 'POWER'
const IDLE_BACKGROUND = '#263238'
const IDLE_ACCENT = '#b0bec5'
const DOTS_Y = 84

interface PowerChoice extends SelectionOption {
    command: PanelActionName
    icon: IconName
    background: string
    accent: string
    /** The face it leaves behind; only for a choice the amp does not come back from by itself. */
    ending?: {label: string, background: string}
}

// Sleep leads, so the choice a stray double-press lands on is the one the room
// wakes from rather than one that needs somebody at the plug.
const CHOICES: readonly PowerChoice[] = [
    {
        label: 'SLEEP',
        command: 'sleep',
        icon: 'moon',
        background: '#37474f',
        accent: '#90a4ae',
    },
    {
        label: 'SHUTDOWN',
        command: 'shutdown',
        icon: 'power',
        background: '#b71c1c',
        accent: '#ff8a80',
        ending: {label: 'HALTING', background: '#4a0000'},
    },
    {
        label: 'REBOOT',
        command: 'reboot',
        icon: 'restart',
        background: '#e65100',
        accent: '#ffcc80',
        ending: {label: 'REBOOTING', background: '#3d1600'},
    },
]

export interface PowerTileConfig {
    label?: string
    armMilliseconds?: number
}

/**
 * The one key that puts the amp down: sleeping, halting, or restarting. It takes
 * two presses — the first arms the key and starts a ring draining back to
 * disarmed, the second confirms — with the shared dial choosing between them
 * while armed. Nothing on the network can start a halted board again, so a
 * single stray press must not be enough.
 */
export class PowerTile implements Tile {
    readonly #power: PowerControls
    readonly #clock: () => number
    readonly #label: string
    readonly #armWindow: number
    readonly #selection: SelectionDial<PowerChoice>
    readonly #armed: ArmedControl
    #armedAt: number | null = null
    #ending: PowerChoice | null = null
    #host: TileHost | null = null
    #tick: NodeJS.Timeout | null = null

    constructor(
        power: PowerControls,
        dial: DynamicDial,
        clock: () => number,
        {label = TITLE, armMilliseconds = ARM_MILLISECONDS}: PowerTileConfig = {},
    ) {
        this.#power = power
        this.#clock = clock
        this.#label = label
        this.#armWindow = armMilliseconds
        this.#selection = new SelectionDial(TITLE, CHOICES, {
            onConfirm: () => this.#confirm(),
            // Turning to read the other choice earns the whole window again.
            onChange: () => {
                this.#armedAt = this.#clock()
                this.#host?.invalidate()
            },
        })
        this.#armed = new ArmedControl(dial, this.#selection, () => this.#confirm())
    }

    press(): void {
        if (this.#ending) return
        if (!this.#armed.armed) {
            this.#armedAt = this.#clock()
            this.#startTick()
        }
        this.#armed.press()
        this.#host?.invalidate()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    mount(host: TileHost): void {
        this.#host = host
    }

    unmount(): void {
        this.#disarm()
        this.#host = null
    }

    #confirm(): void {
        const choice = this.#selection.selected
        this.#disarm()
        if (!choice) return
        if (choice.ending) this.#ending = choice
        panelBinding(this.#power, choice.command).run()
        this.#host?.invalidate()
    }

    #remaining(): number {
        if (this.#armedAt === null) return 0
        return Math.max(0, this.#armWindow - (this.#clock() - this.#armedAt))
    }

    #startTick(): void {
        if (this.#tick) return
        this.#tick = setInterval(() => {
            // The claim can also end elsewhere — another dial cancels it — and
            // the key must stop looking armed the moment it does.
            if (this.#remaining() <= 0 || !this.#armed.armed) this.#disarm()
            this.#host?.invalidate()
        }, TICK_MILLISECONDS)
        this.#tick.unref()
    }

    #disarm(): void {
        this.#armedAt = null
        this.#selection.index = 0
        this.#armed.release()
        if (this.#tick) clearInterval(this.#tick)
        this.#tick = null
    }

    draw(surface: Surface): void {
        const x = surface.width / 2

        const ending = this.#ending
        if (ending?.ending) {
            drawBackground(surface, ending.ending.background)
            drawIcon(surface, ending.icon, {x, y: FACE_CENTER, size: 44, color: ending.accent, opacity: 0.7})
            drawCaption(surface, ending.ending.label)
            return
        }

        const remaining = this.#remaining()
        const choice = this.#selection.selected
        if (remaining <= 0 || !choice) {
            drawBackground(surface, IDLE_BACKGROUND)
            drawIcon(surface, 'power', {x, y: FACE_CENTER, size: 44, color: IDLE_ACCENT})
            drawCaption(surface, this.#label)
            return
        }

        drawBackground(surface, choice.background)
        drawRing(surface, x, remaining / this.#armWindow, choice.accent)
        drawIcon(surface, choice.icon, {x, y: FACE_CENTER - 4, size: 38, color: '#ffffff'})
        drawText(surface, String(Math.ceil(remaining / 1000)), {x, y: FACE_CENTER + 24, size: 18})
        drawDots(surface, CHOICES.length, this.#selection.index, DOTS_Y, '#ffffff')
        drawCaption(surface, choice.label)
        drawActiveGlow(surface, choice.accent)
    }
}

/** The arming window draining away, clockwise from twelve o'clock as the timer's ring runs. */
function drawRing(surface: Surface, x: number, fraction: number, color: string): void {
    const {ctx} = surface
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = RING_WIDTH
    ctx.lineCap = 'round'
    ctx.beginPath()
    const start = -Math.PI / 2
    ctx.arc(x, FACE_CENTER, RING_RADIUS, start, start + fraction * 2 * Math.PI)
    ctx.stroke()
    ctx.restore()
}
