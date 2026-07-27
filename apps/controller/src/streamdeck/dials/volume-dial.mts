import {isVoiceActive} from '../../actions/catalog.mjs'
import {type Binding, volumeBinding} from '../bindings.mjs'
import {type Dial, percent} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'
import type {AudioControls} from '../../types.mjs'

const VOICE_STEP_PERCENT = 5

export class VolumeDial implements Dial {
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    readonly #model: ControlModel
    readonly #audio: AudioControls
    readonly #masterLabel: string

    constructor(audio: AudioControls, model: ControlModel, label = 'VOLUME') {
        this.#model = model
        this.#audio = audio
        this.#masterLabel = label
        this.left = this.#stepped(volumeBinding(audio, 'down'), -1)
        this.right = this.#stepped(volumeBinding(audio, 'up'), 1)
        this.press = volumeBinding(audio, 'mute')
    }

    get label(): string {
        return this.#voiceHolds() ? 'VOICE' : this.#masterLabel
    }

    #voiceHolds(): boolean {
        return isVoiceActive(this.#model.state)
    }

    #stepped(binding: Binding, direction: number): Binding {
        return {
            action: binding.action,
            run: () => {
                if (this.#voiceHolds()) {
                    const voice = this.#model.audio.voiceVolume
                    if (voice !== undefined) {
                        this.#audio.setVoiceVolume(voice + direction * VOICE_STEP_PERCENT)
                    }
                    return
                }
                return binding.run()
            },
        }
    }

    #reading(): number | undefined {
        const {audio} = this.#model
        return this.#voiceHolds() ? audio.voiceVolume : audio.musicVolume
    }

    detail(): string {
        if (!this.#voiceHolds() && this.#model.state.outputMuted) return 'MUTED'
        const reading = this.#reading()
        return reading === undefined ? '?' : percent(reading / 100)
    }

    /** A muted bar reads as empty, which is what muted sounds like. */
    level(): number | undefined {
        if (!this.#voiceHolds() && this.#model.state.outputMuted) return 0
        const reading = this.#reading()
        return reading === undefined ? undefined : reading / 100
    }
}
