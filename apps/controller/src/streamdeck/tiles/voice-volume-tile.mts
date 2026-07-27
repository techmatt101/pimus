import {ArmedControl} from '../armed-control.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {LevelDial} from '../level-dial.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, FACE_CENTER, type Tile} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'
import type {AudioControls} from '../../types.mjs'

export interface VoiceVolumeTileConfig {
    label?: string
}

/**
 * Adjusts the voice level — how loud Assist speaks, rings, and announces,
 * independent of the music level. Press to arm: the shared dial steps it
 * live in 5% notches, clamped at the ends; press again — the key or the
 * knob — to finish.
 */
export class VoiceVolumeTile implements Tile {
    readonly #model: ControlModel
    readonly #label: string
    readonly #armed: ArmedControl

    constructor(
        model: ControlModel,
        audio: AudioControls,
        dial: DynamicDial,
        {label = 'VOICE VOL'}: VoiceVolumeTileConfig = {},
    ) {
        this.#model = model
        this.#label = label
        const control = new LevelDial(label, {
            read: () => this.#model.audio.voiceVolume,
            apply: (percent) => audio.setVoiceVolume(percent),
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
        const voice = this.#model.audio.voiceVolume
        const x = surface.width / 2
        drawBackground(surface, '#00565e')
        drawIcon(surface, 'voice', {x, y: 30, size: 34, color: '#ffffff'})
        // An unreachable audio manager reads as unknown, never as a confident level.
        const value = voice === undefined ? '?' : `${voice}%`
        drawText(surface, value, {x, y: FACE_CENTER + 22, size: fittingSize(value, [30, 26, 22], 112)})
        drawCaption(surface, this.#label)

        if (this.#armed.armed) drawActiveGlow(surface)
    }
}
