// One key that steps the Stream Deck panel's own brightness through a short
// list of levels. The panel brightness is display state, so it lives on the
// ControlModel (state.mts) like mute or what is playing: pressing mutates
// state.brightness and notifies, and the renderer (streamdeck/renderer.mts) is
// what actually re-lights the panel. Unlike a room light there is no entity to
// read back — this is the deck itself — so the level it shows is the one it set.

import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawBackground, drawCaption, drawDots, FACE_CENTER, type Tile} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'

export interface BrightnessTileConfig {
    /** The levels a press cycles through, low to high, each a 0-100 percentage. */
    levels?: readonly number[]
    /** Caption under the reading. */
    label?: string
}

/** A gentle-to-full spread, with the resting default (40) among them. */
const DEFAULT_LEVELS = [20, 40, 70, 100] as const

export class BrightnessTile implements Tile {
    readonly #model: ControlModel
    readonly #levels: readonly number[]
    readonly #label: string

    constructor(model: ControlModel, {levels = DEFAULT_LEVELS, label = 'BRIGHT'}: BrightnessTileConfig = {}) {
        if (levels.length === 0) throw new Error('a brightness tile needs at least one level')
        this.#model = model
        this.#levels = levels
        this.#label = label
    }

    /**
     * The level nearest what the panel is set to now, so the dots track the real
     * brightness even after the sleep controller or a restart set it from
     * elsewhere, and a press steps on from where the panel actually is.
     */
    #currentIndex(brightness: number): number {
        let nearest = 0
        for (let index = 1; index < this.#levels.length; index += 1) {
            const here = this.#levels[index] ?? 0
            const best = this.#levels[nearest] ?? 0
            if (Math.abs(here - brightness) < Math.abs(best - brightness)) nearest = index
        }
        return nearest
    }

    press(): void {
        const state = this.#model.state
        const next = (this.#currentIndex(state.brightness) + 1) % this.#levels.length
        state.brightness = this.#levels[next] ?? state.brightness
        this.#model.notify()
    }

    draw(surface: Surface): void {
        const {brightness} = this.#model.state
        const index = this.#currentIndex(brightness)
        const x = surface.width / 2
        drawBackground(surface, '#37474f')
        drawIcon(surface, 'sun', {x, y: 28, size: 34, color: '#ffffff'})
        const value = `${brightness}%`
        drawText(surface, value, {x, y: FACE_CENTER + 18, size: fittingSize(value, [28, 24, 20], 112)})
        // A dot per level, the current one filled, exactly as the scene and input
        // cycles read, so you can see how many presses bring it back around.
        drawDots(surface, this.#levels.length, index, 78, '#ffffff')
        drawCaption(surface, this.#label)
    }
}
