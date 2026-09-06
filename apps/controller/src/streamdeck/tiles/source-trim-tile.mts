import {ArmedControl} from '../armed-control.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {LevelDial} from '../level-dial.mjs'
import {faceOf, labelOf, type SourceFaces} from '../source-face.mjs'
import type {Surface} from '../surface.mjs'
import {drawDots, type Tile, type TileHost} from '../tile.mjs'
import {drawLevelFace} from './level-tile.mjs'
import type {ControlModel} from '../../state.mjs'
import type {AudioControls} from '../../types.mjs'

export interface SourceTrimTileConfig {
    /** How a source of each name is drawn; one the layout has not heard of gets the plain face. */
    faces?: SourceFaces
}

const WAITING_LABEL = 'TRIM'
const DOTS_Y = 8

/**
 * Every input's trim — the share of the music level it plays at — on one key
 * that walks the list the audio services publish, so a unit offers exactly the
 * inputs it has and the layout never names them. Press to arm the shared dial
 * to the source showing; while armed, press the key again to move to the next
 * source, and press the knob to finish. Nothing is shown until the list arrives.
 */
export class SourceTrimTile implements Tile {
    readonly #model: ControlModel
    readonly #faces: SourceFaces
    readonly #armed: ArmedControl
    #cursor: string | null = null
    #host: TileHost | null = null

    constructor(model: ControlModel, audio: AudioControls, dial: DynamicDial, {faces = {}}: SourceTrimTileConfig = {}) {
        this.#model = model
        this.#faces = faces
        const level = new LevelDial(() => this.#label(), {
            read: () => this.#trim(),
            apply: (percent) => {
                const name = this.#name()
                if (name !== undefined) audio.setSourceTrim(name, percent)
            },
            onConfirm: () => this.#armed.release(),
        })
        this.#armed = new ArmedControl(dial, level, () => this.#next())
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
        const face = faceOf(this.#faces, name)
        drawLevelFace(surface, {
            label: this.#label(),
            icon: face.icon,
            color: face.color,
            level: this.#trim(),
            adjustable: name !== undefined,
            armed: this.#armed.armed,
        })
        if (name !== undefined && names.length > 1) {
            drawDots(surface, names.length, names.indexOf(name), DOTS_Y, '#ffffff')
        }
    }

    #names(): string[] {
        return Object.keys(this.#model.audio.sources)
    }

    #name(): string | undefined {
        const names = this.#names()
        return this.#cursor !== null && names.includes(this.#cursor) ? this.#cursor : names[0]
    }

    #label(): string {
        const name = this.#name()
        return name === undefined ? WAITING_LABEL : labelOf(this.#faces, name)
    }

    #trim(): number | undefined {
        const name = this.#name()
        return name === undefined ? undefined : this.#model.audio.sources[name]?.trim
    }

    #next(): void {
        const names = this.#names()
        const name = this.#name()
        if (name === undefined) return
        this.#cursor = names[(names.indexOf(name) + 1) % names.length] ?? null
        this.#host?.invalidate()
    }
}
