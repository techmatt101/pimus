import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawBackground, drawCaption, FACE_CENTER, type Tile} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'

export interface BrightnessTileConfig {
    label?: string
}

/**
 * Reads out the panel brightness the room's light level is driving
 * (`streamdeck/auto-brightness.mts`). A read-only key: pressing it does nothing
 * on purpose, because the illuminance sensor owns the level.
 */
export class BrightnessTile implements Tile {
    readonly #model: ControlModel
    readonly #label: string

    constructor(model: ControlModel, {label = 'AUTO'}: BrightnessTileConfig = {}) {
        this.#model = model
        this.#label = label
    }

    press(): void {
    }

    draw(surface: Surface): void {
        const {brightness} = this.#model.state
        const x = surface.width / 2
        drawBackground(surface, '#37474f')
        drawIcon(surface, 'sun', {x, y: 30, size: 34, color: '#ffffff'})
        const value = `${brightness}%`
        drawText(surface, value, {x, y: FACE_CENTER + 22, size: fittingSize(value, [30, 26, 22], 112)})
        drawCaption(surface, this.#label)
    }
}
