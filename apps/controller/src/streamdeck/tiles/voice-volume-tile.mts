import {ArmedControl} from '../armed-control.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {SelectionDial, type SelectionOption} from '../selection-dial.mjs'
import {drawIcon, fittingSize, type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, drawDots, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {ControlModel} from '../../state.mjs'
import type {AudioControls} from '../../types.mjs'

export interface VoiceVolumeTileConfig {
    /** The levels a press offers, low to high, each a 0-100 percentage. */
    levels?: readonly number[]
    label?: string
}

interface VoiceVolumeChoice extends SelectionOption {
    level: number
}

const DEFAULT_LEVELS = [20, 40, 60, 80, 100] as const

/**
 * Sets the voice bus level — how loud Assist speaks, rings, and announces,
 * held independently of the master volume the music sits on. Press to arm:
 * the shared dial steps through the levels; press again — the key or the
 * knob — to apply the one showing.
 */
export class VoiceVolumeTile implements Tile {
    readonly #model: ControlModel
    readonly #audio: AudioControls
    readonly #dial: DynamicDial
    readonly #levels: readonly number[]
    readonly #label: string
    readonly #options: readonly VoiceVolumeChoice[]
    readonly #selection: SelectionDial<VoiceVolumeChoice>
    readonly #armed: ArmedControl
    #host: TileHost | null = null

    constructor(
        model: ControlModel,
        audio: AudioControls,
        dial: DynamicDial,
        {levels = DEFAULT_LEVELS, label = 'VOICE VOL'}: VoiceVolumeTileConfig = {},
    ) {
        if (levels.length === 0) throw new Error('a voice volume tile needs at least one level')
        this.#model = model
        this.#audio = audio
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

    #currentIndex(voiceVolume: number): number {
        let nearest = 0
        for (let index = 1; index < this.#levels.length; index += 1) {
            const here = this.#levels[index] ?? 0
            const best = this.#levels[nearest] ?? 0
            if (Math.abs(here - voiceVolume) < Math.abs(best - voiceVolume)) nearest = index
        }
        return nearest
    }

    press(): void {
        if (!this.#armed.armed) {
            const voice = this.#model.audio.voiceVolume
            if (voice !== undefined) this.#selection.index = this.#currentIndex(voice)
        }
        this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    #confirm(): void {
        const choice = this.#selection.selected
        this.#dial.release()
        if (!choice) return
        this.#audio.setVoiceVolume(choice.level)
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
        const voice = this.#model.audio.voiceVolume
        const shown = active ? this.#options[this.#selection.index]?.level : voice
        const index = active
            ? this.#selection.index
            : voice === undefined ? -1 : this.#currentIndex(voice)
        const x = surface.width / 2
        drawBackground(surface, '#00565e')
        drawIcon(surface, 'voice', {x, y: 28, size: 34, color: '#ffffff'})
        // An unreachable audio manager reads as unknown, never as a confident level.
        const value = shown === undefined ? '?' : `${shown}%`
        drawText(surface, value, {x, y: FACE_CENTER + 18, size: fittingSize(value, [28, 24, 20], 112)})
        drawDots(surface, this.#levels.length, index, 78, '#ffffff')
        drawCaption(surface, this.#label)

        if (active) drawActiveGlow(surface)
    }
}
