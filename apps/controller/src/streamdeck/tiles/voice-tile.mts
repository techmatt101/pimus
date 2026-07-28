import {isVoiceActive} from '../../actions/catalog.mjs'
import {type Binding, voiceBinding} from '../bindings.mjs'
import {drawIcon, type Surface, withAlpha} from '../surface.mjs'
import {drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {ControlModel, Unsubscribe} from '../../state.mjs'
import type {Action, LvaSender} from '../../types.mjs'

const FRAME_MILLISECONDS = 120
const RIPPLE_PERIOD_MILLISECONDS = 1600
const RIPPLE_RADIUS = 52

export class VoiceTile implements Tile {
    readonly #model: ControlModel
    readonly #toggle: Binding
    #host: TileHost | null = null
    #unsubscribe: Unsubscribe | null = null
    #ripple: NodeJS.Timeout | null = null
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
        this.#unsubscribe = this.#model.subscribe(() => this.#followVoice())
        this.#followVoice()
    }

    unmount(): void {
        this.#unsubscribe?.()
        this.#unsubscribe = null
        this.#stopRipple()
        this.#host = null
    }

    #followVoice(): void {
        if (isVoiceActive(this.#model.state)) this.#startRipple()
        else this.#stopRipple()
    }

    #startRipple(): void {
        if (this.#ripple) return
        this.#phase = 0
        this.#ripple = setInterval(() => this.#host?.invalidate(), FRAME_MILLISECONDS)
        this.#ripple.unref()
    }

    #stopRipple(): void {
        if (this.#ripple) clearInterval(this.#ripple)
        this.#ripple = null
    }

    draw(surface: Surface, deltaTime: number): void {
        const running = isVoiceActive(this.#model.state)
        drawBackground(surface, running ? '#006064' : '#00272b')
        const x = surface.width / 2

        if (running) {
            // Two rings a half-cycle apart, each fading as it grows, so the
            // sweep reads as continuous rather than restarting.
            const {ctx} = surface
            this.#phase += deltaTime
            const phase = (this.#phase % RIPPLE_PERIOD_MILLISECONDS) / RIPPLE_PERIOD_MILLISECONDS
            ctx.save()
            ctx.lineWidth = 3
            for (const offset of [0, 0.5]) {
                const step = (phase + offset) % 1
                ctx.strokeStyle = withAlpha('#00e5ff', 1 - step)
                ctx.beginPath()
                ctx.arc(x, FACE_CENTER, 18 + step * RIPPLE_RADIUS, 0, 2 * Math.PI)
                ctx.stroke()
            }
            ctx.restore()
        }

        drawIcon(surface, 'mic', {
            x,
            y: FACE_CENTER,
            size: 52,
            color: running ? '#ffffff' : '#4dd0e1',
        })
        drawCaption(surface, running ? 'CANCEL' : 'VOICE')
    }
}
