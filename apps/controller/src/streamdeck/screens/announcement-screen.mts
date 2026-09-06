import {drawIcon, drawText, lighten, measureText, type Surface, verticalGradient} from '../surface.mjs'
import {type Screen, type ScreenHost, STRIP_WIDTH} from './screen.mjs'
import type {ControlModel} from '../../state.mjs'

const FRAME_MILLISECONDS = 80
const PULSE_PERIOD_MILLISECONDS = 1400

const TITLE = 'ANNOUNCEMENT'
const TITLE_SIZE = 44
const ICON_SIZE = 48
const ICON_GAP = 22
const ROW_Y = 50

const COLOR = '#00838f'
const TEXT_COLOR = '#ffffff'

/**
 * The face the strip takes while the assistant's own media player is
 * playing: a clip Home Assistant sends it, which is what ducks the music.
 */
export class AnnouncementScreen implements Screen {
    readonly #model: ControlModel
    #unsubscribe: (() => void) | null = null
    #phase = 0

    constructor(model: ControlModel) {
        this.#model = model
    }

    mount(host: ScreenHost): void {
        this.#unsubscribe = this.#model.subscribe(() => host.invalidate())
    }

    unmount(): void {
        this.#unsubscribe?.()
        this.#unsubscribe = null
        this.#phase = 0
    }

    applies(): boolean {
        return this.#model.state.media
    }

    animationMilliseconds(): number {
        return FRAME_MILLISECONDS
    }

    draw(surface: Surface, deltaTime: number): void {
        this.#phase += deltaTime
        const step = (this.#phase % PULSE_PERIOD_MILLISECONDS) / PULSE_PERIOD_MILLISECONDS
        const pulse = 0.45 + 0.55 * (0.5 - Math.cos(step * 2 * Math.PI) / 2)

        surface.fill(verticalGradient(surface, lighten(COLOR, 0.22), COLOR))

        const width = ICON_SIZE + ICON_GAP + measureText(TITLE, TITLE_SIZE)
        const start = (STRIP_WIDTH - width) / 2
        drawIcon(surface, 'megaphone', {x: start + ICON_SIZE / 2, y: ROW_Y, size: ICON_SIZE, color: TEXT_COLOR, opacity: pulse})
        drawText(surface, TITLE, {x: start + ICON_SIZE + ICON_GAP, y: ROW_Y, size: TITLE_SIZE, color: TEXT_COLOR, align: 'left'})
    }
}
