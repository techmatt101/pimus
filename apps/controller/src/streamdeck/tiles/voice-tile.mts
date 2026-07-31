import {type Binding, voiceBinding} from '../bindings.mjs'
import {drawIcon, type Surface, withAlpha} from '../surface.mjs'
import {drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {ControlModel, Unsubscribe} from '../../state.mjs'
import type {Action, LvaSender} from '../../types.mjs'

const FRAME_MILLISECONDS = 120
const RIPPLE_PERIOD_MILLISECONDS = 1600
const RIPPLE_RADIUS = 52
const ORBIT_PERIOD_MILLISECONDS = 1200
const PULSE_PERIOD_MILLISECONDS = 900

type VoiceAnimation = 'ripple' | 'orbit' | 'pulse'

interface VoiceFace {
    background: string
    accent: string
    iconColor: string
    caption: string
    animation?: VoiceAnimation
}

const IDLE_FACE: VoiceFace = {
    background: '#00272b',
    accent: '#4dd0e1',
    iconColor: '#4dd0e1',
    caption: 'VOICE',
}

// Colours track the ReSpeaker ring in voice/led-states.mts, so the key and the
// LEDs read as one device.
const VOICE_FACES: ReadonlyMap<string, VoiceFace> = new Map(Object.entries({
    WAKE_WORD_DETECTED: {
        background: '#004d56',
        accent: '#00e5ff',
        iconColor: '#ffffff',
        caption: 'WAKE WORD',
        animation: 'pulse',
    },
    LISTENING: {
        background: '#006064',
        accent: '#00e5ff',
        iconColor: '#ffffff',
        caption: 'LISTENING',
        animation: 'ripple',
    },
    TRANSCRIBING: {
        background: '#00363a',
        accent: '#00e5ff',
        iconColor: '#ffffff',
        caption: 'HEARD YOU',
        animation: 'orbit',
    },
    THINKING: {
        background: '#311b92',
        accent: '#7c4dff',
        iconColor: '#ffffff',
        caption: 'THINKING',
        animation: 'orbit',
    },
    TTS_SPEAKING: {
        background: '#37474f',
        accent: '#ffffff',
        iconColor: '#ffffff',
        caption: 'SPEAKING',
        animation: 'pulse',
    },
    PIPELINE_ERROR: {
        background: '#3e0a12',
        accent: '#ff1744',
        iconColor: '#ff8a80',
        caption: 'ERROR',
        animation: 'pulse',
    },
    DISCONNECTED: {
        background: '#131a1d',
        accent: '#546e7a',
        iconColor: '#546e7a',
        caption: 'OFFLINE',
    },
}))

export class VoiceTile implements Tile {
    readonly #model: ControlModel
    readonly #toggle: Binding
    #host: TileHost | null = null
    #unsubscribe: Unsubscribe | null = null
    #animation: NodeJS.Timeout | null = null
    #phase = 0

    constructor(model: ControlModel, lva: LvaSender) {
        this.#model = model
        this.#toggle = voiceBinding(lva, model, 'listen_toggle')
    }

    action(): Action {
        return this.#toggle.action
    }

    press(): void {
        this.#toggle.run()
    }

    mount(host: TileHost): void {
        this.#host = host
        this.#unsubscribe = this.#model.subscribe(() => this.#followAssist())
        this.#followAssist()
    }

    unmount(): void {
        this.#unsubscribe?.()
        this.#unsubscribe = null
        this.#stopAnimation()
        this.#host = null
    }

    #face(): VoiceFace {
        return VOICE_FACES.get(this.#model.state.assist) ?? IDLE_FACE
    }

    #followAssist(): void {
        if (this.#face().animation) this.#startAnimation()
        else this.#stopAnimation()
    }

    #startAnimation(): void {
        if (this.#animation) return
        this.#phase = 0
        this.#animation = setInterval(() => this.#host?.invalidate(), FRAME_MILLISECONDS)
        this.#animation.unref()
    }

    #stopAnimation(): void {
        if (this.#animation) clearInterval(this.#animation)
        this.#animation = null
    }

    draw(surface: Surface, deltaTime: number): void {
        const face = this.#face()
        drawBackground(surface, face.background)
        const x = surface.width / 2

        if (face.animation) {
            this.#phase += deltaTime
            if (face.animation === 'ripple') this.#drawRipple(surface, x, face.accent)
            else if (face.animation === 'orbit') this.#drawOrbit(surface, x, face.accent)
            else this.#drawPulse(surface, x, face.accent)
        }

        drawIcon(surface, 'mic', {
            x,
            y: FACE_CENTER,
            size: 52,
            color: face.iconColor,
        })
        drawCaption(surface, face.caption)
    }

    #drawRipple(surface: Surface, x: number, accent: string): void {
        // Two rings a half-cycle apart, each fading as it grows, so the
        // sweep reads as continuous rather than restarting.
        const {ctx} = surface
        const phase = (this.#phase % RIPPLE_PERIOD_MILLISECONDS) / RIPPLE_PERIOD_MILLISECONDS
        ctx.save()
        ctx.lineWidth = 3
        for (const offset of [0, 0.5]) {
            const step = (phase + offset) % 1
            ctx.strokeStyle = withAlpha(accent, 1 - step)
            ctx.beginPath()
            ctx.arc(x, FACE_CENTER, 18 + step * RIPPLE_RADIUS, 0, 2 * Math.PI)
            ctx.stroke()
        }
        ctx.restore()
    }

    #drawOrbit(surface: Surface, x: number, accent: string): void {
        const {ctx} = surface
        const angle = ((this.#phase % ORBIT_PERIOD_MILLISECONDS) / ORBIT_PERIOD_MILLISECONDS) * 2 * Math.PI
        ctx.save()
        ctx.strokeStyle = withAlpha(accent, 0.9)
        ctx.lineWidth = 4
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.arc(x, FACE_CENTER, 36, angle, angle + Math.PI * 1.25)
        ctx.stroke()
        ctx.restore()
    }

    #drawPulse(surface: Surface, x: number, accent: string): void {
        const {ctx} = surface
        const step = (this.#phase % PULSE_PERIOD_MILLISECONDS) / PULSE_PERIOD_MILLISECONDS
        const swell = (1 - Math.cos(step * 2 * Math.PI)) / 2
        ctx.save()
        ctx.strokeStyle = withAlpha(accent, 0.3 + swell * 0.5)
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(x, FACE_CENTER, 26 + swell * 10, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.restore()
    }
}
