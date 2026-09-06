import {ArmedControl} from '../armed-control.mjs'
import type {Dial} from '../dial.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {faceOf, labelOf, type SourceFaces} from '../source-face.mjs'
import {drawIcon, type Surface} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, drawDots, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'
import type {AudioControls} from '../../types.mjs'

export interface SourceRouteTileConfig {
    /** How a source of each name is drawn; one the layout has not heard of gets the plain face. */
    faces?: SourceFaces
}

const DIAL_LABEL = 'ROUTE'
const ON_COLOR = '#1b5e20'
const NONE_BACKGROUND = '#131a1d'
const NONE_INK = '#546e7a'
const OFF_ICON = '#607d8b'
const ICON_SIZE = 48
const DOTS_Y = 8

/**
 * Every switchable input on one key that walks the routes the audio services
 * publish — the sources with a toggle — so a unit offers exactly the routes it
 * has and the layout never names them. Press to arm the shared dial; turn it to
 * choose a route, press the key to switch the one showing, and press the knob
 * to finish. A unit with nothing to switch draws the key dark and inert.
 */
export class SourceRouteTile implements Tile {
    readonly #model: ControlModel
    readonly #audio: AudioControls
    readonly #faces: SourceFaces
    readonly #armed: ArmedControl
    #cursor: string | null = null
    #host: TileHost | null = null

    constructor(model: ControlModel, audio: AudioControls, dial: DynamicDial, {faces = {}}: SourceRouteTileConfig = {}) {
        this.#model = model
        this.#audio = audio
        this.#faces = faces
        const picker: Dial = {
            label: DIAL_LABEL,
            left: {action: {type: 'noop'}, run: () => this.#step(-1)},
            right: {action: {type: 'noop'}, run: () => this.#step(1)},
            press: {action: {type: 'noop'}, run: () => this.#armed.release()},
            detail: () => {
                const name = this.#name()
                return name === undefined ? '--' : this.#caption(name)
            },
        }
        this.#armed = new ArmedControl(dial, picker, () => this.#toggle())
    }

    press(): void {
        if (this.#name() !== undefined) this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    mount(host: TileHost): void {
        this.#host = host
    }

    unmount(): void {
        this.#host = null
        this.#armed.release()
    }

    draw(surface: Surface): void {
        const names = this.#names()
        const name = this.#name()
        const x = surface.width / 2
        if (name === undefined) {
            drawBackground(surface, NONE_BACKGROUND)
            drawIcon(surface, 'cable', {x, y: FACE_CENTER, size: ICON_SIZE, color: NONE_INK})
            drawCaption(surface, DIAL_LABEL, NONE_INK)
            return
        }
        const face = faceOf(this.#faces, name)
        const on = this.#enabled(name)
        drawBackground(surface, on ? ON_COLOR : face.color)
        drawIcon(surface, face.icon, {x, y: FACE_CENTER, size: ICON_SIZE, color: on ? '#ffffff' : OFF_ICON})
        if (names.length > 1) drawDots(surface, names.length, names.indexOf(name), DOTS_Y, '#ffffff')
        drawCaption(surface, this.#caption(name))
        if (this.#armed.armed) drawActiveGlow(surface)
    }

    #names(): string[] {
        return Object.entries(this.#model.audio.sources)
            .filter(([, source]) => source?.enabled !== undefined)
            .map(([name]) => name)
    }

    #name(): string | undefined {
        const names = this.#names()
        return this.#cursor !== null && names.includes(this.#cursor) ? this.#cursor : names[0]
    }

    #enabled(name: string): boolean {
        return this.#model.audio.sources[name]?.enabled === true
    }

    #caption(name: string): string {
        return `${labelOf(this.#faces, name)} ${this.#enabled(name) ? 'ON' : 'OFF'}`
    }

    #step(delta: number): void {
        const names = this.#names()
        const name = this.#name()
        if (name === undefined) return
        const count = names.length
        this.#cursor = names[((names.indexOf(name) + delta) % count + count) % count] ?? null
        this.#host?.invalidate()
    }

    #toggle(): void {
        const name = this.#name()
        if (name !== undefined) this.#audio.setSourceState(name, 'toggle')
    }
}
