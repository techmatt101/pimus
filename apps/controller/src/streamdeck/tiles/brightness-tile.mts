import {ArmedControl} from '../armed-control.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {LevelDial} from '../level-dial.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, FACE_CENTER, type Tile} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'

export interface BrightnessTileConfig {
    label?: string
}

/**
 * Adjusts the Stream Deck panel's own brightness. Press to arm: the shared
 * dial steps it live in 5% notches, clamped at the ends; press again — the
 * key or the knob — to finish.
 */
export class BrightnessTile implements Tile {
    readonly #model: ControlModel
    readonly #label: string
    readonly #armed: ArmedControl

    constructor(model: ControlModel, dial: DynamicDial, {label = 'BRIGHT'}: BrightnessTileConfig = {}) {
        this.#model = model
        this.#label = label
        const control = new LevelDial(label, {
            read: () => this.#model.state.brightness,
            apply: (percent) => {
                this.#model.state.brightness = percent
                this.#model.notify()
            },
            onConfirm: () => this.#armed.release(),
        })
        this.#armed = new ArmedControl(dial, control, () => this.#armed.release())
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
        const x = surface.width / 2
        drawBackground(surface, '#37474f')
        drawIcon(surface, 'sun', {x, y: 30, size: 34, color: '#ffffff'})
        const value = `${brightness}%`
        drawText(surface, value, {x, y: FACE_CENTER + 22, size: fittingSize(value, [30, 26, 22], 112)})
        drawCaption(surface, this.#label)

        if (this.#armed.armed) drawActiveGlow(surface)
    }
}
