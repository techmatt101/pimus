import {drawIcon, drawText, measureText, type Surface} from '../surface.mjs'
import {type Screen, STRIP_WIDTH} from './screen.mjs'
import type {IconName} from '../icon-set.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HealthState} from '../../types.mjs'

// Long enough to cover PipeWire, the audio graph reconcile, and the voice
// assistant's own wait for it. After this a subsystem that is still down is a
// fault, and the ordinary faces say so with a red status icon.
const BOOT_GRACE_MILLISECONDS = 90_000

const FRAME_MILLISECONDS = 250
const PENDING_PERIOD_MILLISECONDS = 1200

const TITLE = 'STARTING UP'
const TITLE_SIZE = 34
const TITLE_Y = 32

const ROW_Y = 74
const LABEL_SIZE = 20
const ICON_SIZE = 22
const SLOT_WIDTH = 200
const ICON_GAP = 14

const BACKDROP = '#000000'
const TITLE_COLOR = '#ffffff'
const READY_COLOR = '#26c6da'
const PENDING_COLOR = '#ffab00'

const SUBSYSTEMS: ReadonlyArray<{ key: keyof HealthState; label: string; icon: IconName }> = [
    {key: 'network', label: 'NETWORK', icon: 'wifi'},
    {key: 'audio', label: 'AUDIO', icon: 'volume'},
    {key: 'ha', label: 'HOME', icon: 'home'},
]

/**
 * The face the strip rests on while the stack is still coming up. It exists
 * because the controller now paints long before the audio manager, voice
 * assistant, and Home Assistant have connected: without it the first thing the
 * panel shows is a row of red fault icons, which reads as broken rather than
 * busy. It stops applying the moment everything is up, and latches off for good
 * so a later outage is reported as the fault it is.
 */
export class StartingScreen implements Screen {
    readonly #model: ControlModel
    readonly #clock: () => number
    readonly #graceMilliseconds: number
    readonly #startedAt: number
    #settled = false
    #phase = 0

    constructor(model: ControlModel, clock: () => number, graceMilliseconds = BOOT_GRACE_MILLISECONDS) {
        this.#model = model
        this.#clock = clock
        this.#graceMilliseconds = graceMilliseconds
        this.#startedAt = clock()
    }

    applies(): boolean {
        if (this.#settled) return false
        if (SUBSYSTEMS.every(({key}) => this.#model.state.health[key])) {
            this.#settled = true
            return false
        }
        if (this.#clock() - this.#startedAt >= this.#graceMilliseconds) {
            this.#settled = true
            return false
        }
        return true
    }

    animationMilliseconds(): number {
        return FRAME_MILLISECONDS
    }

    draw(surface: Surface, deltaTime: number): void {
        surface.fill(BACKDROP)
        drawText(surface, TITLE, {x: STRIP_WIDTH / 2, y: TITLE_Y, size: TITLE_SIZE, color: TITLE_COLOR})

        this.#phase += deltaTime
        const step = (this.#phase % PENDING_PERIOD_MILLISECONDS) / PENDING_PERIOD_MILLISECONDS
        const breath = 0.35 + 0.65 * (0.5 - Math.cos(step * 2 * Math.PI) / 2)
        const left = (STRIP_WIDTH - SUBSYSTEMS.length * SLOT_WIDTH) / 2

        SUBSYSTEMS.forEach(({key, label, icon}, slot) => {
            const ready = this.#model.state.health[key]
            const color = ready ? READY_COLOR : PENDING_COLOR
            const center = left + SLOT_WIDTH * (slot + 0.5)
            const options = ready ? {} : {opacity: breath}
            const width = ICON_SIZE + ICON_GAP + measureText(label, LABEL_SIZE)
            const start = center - width / 2
            drawIcon(surface, icon, {
                x: start + ICON_SIZE / 2,
                y: ROW_Y,
                size: ICON_SIZE,
                color,
                ...options,
            })
            drawText(surface, label, {
                x: start + ICON_SIZE + ICON_GAP,
                y: ROW_Y,
                size: LABEL_SIZE,
                color,
                align: 'left',
                ...options,
            })
        })
    }
}
