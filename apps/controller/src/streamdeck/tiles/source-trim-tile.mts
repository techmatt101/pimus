import {ArmedControl} from '../armed-control.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import type {IconName} from '../icon-set.mjs'
import {LevelDial} from '../level-dial.mjs'
import type {Surface} from '../surface.mjs'
import {drawBackground, type Tile} from '../tile.mjs'
import {drawLevelFace} from './level-tile.mjs'
import type {ControlModel} from '../../state.mjs'
import type {AudioControls} from '../../types.mjs'

export interface SourceFace {
    /** Defaults to the source's name, upper-cased. */
    label?: string
    icon: IconName
    color: string
}

export interface SourceTrimTileConfig {
    /** Which source this key shows, counting through the list the audio services publish. */
    slot: number
    /** How a source of each name is drawn; one the layout has not heard of gets the plain face. */
    faces?: Partial<Record<string, SourceFace>>
}

const PLAIN_FACE: SourceFace = {icon: 'note', color: '#37474f'}
const EMPTY_SLOT_COLOR = '#0a0d10'

/**
 * One input's trim — the share of the music level it plays at — for whichever
 * source occupies this slot of the audio services' own list, so a unit shows
 * exactly the inputs it has and the layout never names them. Press to arm the
 * shared dial to that trim, as `LevelTile` does; the slot may hold a different
 * source after a manager restart, so the armed control is looked up by name.
 */
export class SourceTrimTile implements Tile {
    readonly #model: ControlModel
    readonly #audio: AudioControls
    readonly #dial: DynamicDial
    readonly #slot: number
    readonly #faces: Partial<Record<string, SourceFace>>
    readonly #controls = new Map<string, ArmedControl>()

    constructor(model: ControlModel, audio: AudioControls, dial: DynamicDial, {slot, faces = {}}: SourceTrimTileConfig) {
        this.#model = model
        this.#audio = audio
        this.#dial = dial
        this.#slot = slot
        this.#faces = faces
    }

    press(): void {
        const name = this.#name()
        if (name !== undefined) this.#control(name).press()
    }

    holdsDial(): boolean {
        for (const control of this.#controls.values()) if (control.armed) return true
        return false
    }

    unmount(): void {
        for (const control of this.#controls.values()) control.release()
    }

    draw(surface: Surface): void {
        const name = this.#name()
        if (name === undefined) {
            drawBackground(surface, EMPTY_SLOT_COLOR)
            return
        }
        const face = this.#faces[name] ?? PLAIN_FACE
        drawLevelFace(surface, {
            label: face.label ?? name.toUpperCase(),
            icon: face.icon,
            color: face.color,
            level: this.#trim(name),
            adjustable: true,
            armed: this.#controls.get(name)?.armed === true,
        })
    }

    #name(): string | undefined {
        return Object.keys(this.#model.audio.sources)[this.#slot]
    }

    #trim(name: string): number | undefined {
        return this.#model.audio.sources[name]?.trim
    }

    #control(name: string): ArmedControl {
        let control = this.#controls.get(name)
        if (control) return control
        const level = new LevelDial(this.#faces[name]?.label ?? name.toUpperCase(), {
            read: () => this.#trim(name),
            apply: (percent) => this.#audio.setSourceTrim(name, percent),
            onConfirm: () => control?.release(),
        })
        control = new ArmedControl(this.#dial, level, () => control?.release())
        this.#controls.set(name, control)
        return control
    }
}
