import {ArmedControl} from '../armed-control.mjs'
import {BrightnessDial} from '../dials/brightness-dial.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, FACE_CENTER, type Tile} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'
import type {BrightnessControls} from '../../types.mjs'

const DIAL_LABEL = 'BRIGHTNESS'

const AUTO_COLOR = '#37474f'
const MANUAL_COLOR = '#1b2429'

/**
 * The panel's brightness key. It reads out the level the room's light is
 * driving (`streamdeck/auto-brightness.mts`); the first press arms the shared
 * dial, which tunes the lux the panel counts as a fully lit room, and a second
 * press — the key or the knob — switches that following off and leaves the
 * level to the dial by hand.
 */
export class BrightnessTile implements Tile {
    readonly #model: ControlModel
    readonly #controls: BrightnessControls
    readonly #armed: ArmedControl

    constructor(model: ControlModel, controls: BrightnessControls, dial: DynamicDial) {
        this.#model = model
        this.#controls = controls
        const control = new BrightnessDial(DIAL_LABEL, model, controls)
        this.#armed = new ArmedControl(dial, control, () => controls.setAuto(!controls.auto))
    }

    press(): void {
        this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    unmount(): void {
        this.#armed.release()
    }

    draw(surface: Surface): void {
        const {brightness} = this.#model.state
        const {auto} = this.#controls
        const x = surface.width / 2
        drawBackground(surface, auto ? AUTO_COLOR : MANUAL_COLOR)
        drawIcon(surface, 'sun', {x, y: 30, size: 34, color: auto ? '#ffffff' : '#78909c'})
        const value = `${brightness}%`
        drawText(surface, value, {
            x,
            y: FACE_CENTER + 22,
            size: fittingSize(value, [30, 26, 22], 112),
            color: auto ? '#ffffff' : '#b0bec5',
        })
        drawCaption(surface, auto ? 'AUTO' : 'MANUAL')

        if (this.#armed.armed) drawActiveGlow(surface)
    }
}
