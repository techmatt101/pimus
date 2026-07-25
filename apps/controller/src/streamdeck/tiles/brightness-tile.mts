import {ArmedControl} from '../armed-control.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {SelectionDial, type SelectionOption} from '../selection-dial.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, drawDots, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'

export interface BrightnessTileConfig {
    /** The levels a press cycles through, low to high, each a 0-100 percentage. */
    levels?: readonly number[]
    label?: string
}

interface BrightnessChoice extends SelectionOption {
    level: number
}

const DEFAULT_LEVELS = [20, 40, 70, 100] as const

/**
 * Steps the Stream Deck panel's own brightness. Press to arm: the shared dial
 * steps through the levels; press again — the key or the knob — to apply the
 * one showing.
 */
export class BrightnessTile implements Tile {
    readonly #model: ControlModel
    readonly #dial: DynamicDial
    readonly #levels: readonly number[]
    readonly #label: string
    readonly #options: readonly BrightnessChoice[]
    readonly #selection: SelectionDial<BrightnessChoice>
    readonly #armed: ArmedControl
    #host: TileHost | null = null

    constructor(model: ControlModel, dial: DynamicDial, {levels = DEFAULT_LEVELS, label = 'BRIGHT'}: BrightnessTileConfig = {}) {
        if (levels.length === 0) throw new Error('a brightness tile needs at least one level')
        this.#model = model
        this.#dial = dial
        this.#levels = levels
        this.#label = label
        this.#options = levels.map((level) => ({label: `${level}%`, level}))
        this.#selection = new SelectionDial(label, this.#options, {
            onConfirm: () => this.#confirm(),
            onChange: () => this.#host?.invalidate(),
        })
        this.#armed = new ArmedControl(dial, this.#selection, () => this.#confirm())
    }

    // The level nearest what the panel is set to now, so the dots track the real
    // brightness even after the sleep controller or a restart set it elsewhere.
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
        // Start the picker at the level the panel is actually set to.
        if (!this.#armed.armed) this.#selection.index = this.#currentIndex(this.#model.state.brightness)
        this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    #confirm(): void {
        const choice = this.#selection.selected
        this.#dial.release()
        if (!choice) return
        this.#model.state.brightness = choice.level
        this.#model.notify()
    }

    mount(host: TileHost): void {
        this.#host = host
    }

    unmount(): void {
        this.#host = null
        this.#armed.release()
    }

    draw(surface: Surface): void {
        const active = this.#armed.armed
        const {brightness} = this.#model.state
        const index = active ? this.#selection.index : this.#currentIndex(brightness)
        const shown = active ? this.#options[this.#selection.index]?.level ?? brightness : brightness
        const x = surface.width / 2
        drawBackground(surface, '#37474f')
        drawIcon(surface, 'sun', {x, y: 28, size: 34, color: '#ffffff'})
        const value = `${shown}%`
        drawText(surface, value, {x, y: FACE_CENTER + 18, size: fittingSize(value, [28, 24, 20], 112)})
        drawDots(surface, this.#levels.length, index, 78, '#ffffff')
        drawCaption(surface, this.#label)

        if (active) drawActiveGlow(surface)
    }
}
