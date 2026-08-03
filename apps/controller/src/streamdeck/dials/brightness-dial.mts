import type {Binding} from '../bindings.mjs'
import type {Dial} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'
import type {BrightnessControls} from '../../types.mjs'

// Lux is read logarithmically, so the notches crowd around an unlit room and
// open out towards daylight rather than stepping evenly to a number nobody
// would pick.
const LUX_NOTCHES = [20, 50, 100, 150, 200, 300, 400, 500, 650, 800, 1000, 1250, 1500, 2000]

const PERCENT_STEP = 5

function nearestNotch(lux: number): number {
    let nearest = 0
    let closest = Infinity
    for (const [index, notch] of LUX_NOTCHES.entries()) {
        const distance = Math.abs(notch - lux)
        if (distance >= closest) continue
        closest = distance
        nearest = index
    }
    return nearest
}

/**
 * The panel's own knob, which turns whichever number is deciding the level:
 * `brightLux` — how bright this room reads when it is fully lit — while auto
 * brightness is following the sensor, and the panel percent itself once it is
 * switched off. Pressing switches between the two.
 */
export class BrightnessDial implements Dial {
    readonly label: string
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #model: ControlModel
    readonly #controls: BrightnessControls

    constructor(label: string, model: ControlModel, controls: BrightnessControls) {
        this.label = label
        this.#model = model
        this.#controls = controls
        this.left = {action: {type: 'noop'}, run: () => this.#turn(-1)}
        this.right = {action: {type: 'noop'}, run: () => this.#turn(1)}
        this.press = {action: {type: 'noop'}, run: () => this.#controls.setAuto(!this.#controls.auto)}
    }

    detail(): string {
        if (!this.#controls.auto) return `${this.#model.state.brightness}%`
        return `FULL AT ${this.#controls.brightLux} LX`
    }

    level(): number {
        if (!this.#controls.auto) return this.#model.state.brightness / 100
        return nearestNotch(this.#controls.brightLux) / (LUX_NOTCHES.length - 1)
    }

    #turn(direction: number): void {
        if (!this.#controls.auto) {
            return this.#controls.setBrightness(this.#model.state.brightness + direction * PERCENT_STEP)
        }
        const index = nearestNotch(this.#controls.brightLux) + direction
        const notch = LUX_NOTCHES[Math.max(0, Math.min(LUX_NOTCHES.length - 1, index))]
        if (notch !== undefined) this.#controls.setBrightLux(notch)
    }
}
