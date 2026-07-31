import {requireEntity} from '../../actions/catalog.mjs'
import {numericAttribute} from '../../home-assistant/entity.mjs'
import {conditionIcon} from '../icons.mjs'
import {hasMedia} from './now-playing-screen.mjs'
import {drawStatusIcons, hasFault, STATUS_FLASH_FRAME_MILLISECONDS} from './status-icons.mjs'
import {drawIcon, drawText, measureText, type Surface} from '../surface.mjs'
import {type ClockFormat, drawClock, formatDate, minuteTick, type Screen, type ScreenHost, STRIP_WIDTH} from './screen.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantService} from '../../types.mjs'

const BACKDROP = '#000000'
const TIME_COLOR = '#eceff1'
const DATE_COLOR = '#90a4ae'
const TEMPERATURE_COLOR = '#80deea'
const TIME_SIZE = 64
const ROW_Y = 50
const DATE_SIZE = 24
const DATE_GAP = 20
const WEATHER_GAP = 28

export interface IdleScreenOptions {
    player: string
    /** The `weather.` entity shown beside the clock; omitting it leaves the clock alone. */
    weatherEntityId?: string
    clockFormat?: ClockFormat
}

const STATUS_X = 44
const STATUS_SIZE = 24
const STATUS_GAP = 12

const MEDIA_LEFT = 200
const MEDIA_RIGHT = 320
const MEDIA_CENTER = (MEDIA_LEFT + MEDIA_RIGHT) / 2
const MEDIA_PILL_WIDTH = 92
const MEDIA_PILL_HEIGHT = 60
const MEDIA_ICON_SIZE = 34
const MEDIA_PILL = '#101f26'
const MEDIA_PLAYING = '#26c6da'
const MEDIA_PAUSED = '#546e7a'

/** The strip's resting face when nothing is playing: a clock, with the weather beside it. */
export class IdleScreen implements Screen {
    readonly #ha: HomeAssistantService
    readonly #model: ControlModel
    readonly #clock: () => number
    readonly #weather: string | undefined
    readonly #player: string
    readonly #clockFormat: ClockFormat
    #unwatch: (() => void) | null = null
    #phase = 0
    #showNowPlaying: (() => void) | null = null

    constructor(ha: HomeAssistantService, model: ControlModel, clock: () => number, {player, weatherEntityId, clockFormat = '24h'}: IdleScreenOptions) {
        this.#ha = ha
        this.#model = model
        this.#clock = clock
        this.#weather = weatherEntityId ? requireEntity(weatherEntityId, 'idle screen') : undefined
        this.#player = requireEntity(player, 'idle screen')
        this.#clockFormat = clockFormat
    }

    mount(host: ScreenHost): void {
        const watched = this.#weather ? [this.#player, this.#weather] : [this.#player]
        this.#unwatch = this.#ha.watch(watched, () => host.invalidate())
    }

    /** Wired by the layout once the strip exists, since the screen is built before it. */
    showNowPlayingOn(reveal: () => void): void {
        this.#showNowPlaying = reveal
    }

    pressAt(x: number): (() => unknown) | undefined {
        if (!hasMedia(this.#ha, this.#player) || x < MEDIA_LEFT || x >= MEDIA_RIGHT) return undefined
        const reveal = this.#showNowPlaying
        return reveal ? () => reveal() : undefined
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
    }

    animationMilliseconds(): number {
        const tick = minuteTick(this.#clock())
        return hasFault(this.#model.state) ? Math.min(tick, STATUS_FLASH_FRAME_MILLISECONDS) : tick
    }

    draw(surface: Surface, deltaTime: number): void {
        surface.fill(BACKDROP)
        const now = this.#clock()
        this.#phase += deltaTime
        const clock = drawClock(surface, now, this.#clockFormat, {centerX: STRIP_WIDTH / 2, y: ROW_Y, size: TIME_SIZE, color: TIME_COLOR})
        const date = formatDate(now)
        const dateLeft = clock.right + DATE_GAP
        drawText(surface, date, {x: dateLeft, y: ROW_Y, size: DATE_SIZE, color: DATE_COLOR, align: 'left'})
        this.#drawWeather(surface, dateLeft + measureText(date, DATE_SIZE) + WEATHER_GAP)
        drawStatusIcons(surface, this.#model.state, {x: STATUS_X, y: ROW_Y, size: STATUS_SIZE, gap: STATUS_GAP, phase: this.#phase})
        this.#drawMedia(surface)
    }

    #drawMedia(surface: Surface): void {
        if (!hasMedia(this.#ha, this.#player)) return
        const {ctx} = surface
        ctx.save()
        ctx.fillStyle = MEDIA_PILL
        ctx.beginPath()
        ctx.roundRect(MEDIA_CENTER - MEDIA_PILL_WIDTH / 2, ROW_Y - MEDIA_PILL_HEIGHT / 2, MEDIA_PILL_WIDTH, MEDIA_PILL_HEIGHT, 16)
        ctx.fill()
        ctx.restore()
        const playing = this.#ha.entity(this.#player)?.state === 'playing'
        drawIcon(surface, 'note', {x: MEDIA_CENTER, y: ROW_Y, size: MEDIA_ICON_SIZE, color: playing ? MEDIA_PLAYING : MEDIA_PAUSED})
    }

    #drawWeather(surface: Surface, left: number): void {
        const weather = this.#weather ? this.#ha.entity(this.#weather) : undefined
        if (!weather || weather.state === 'unknown' || weather.state === 'unavailable') return
        const {icon, color} = conditionIcon(weather.state)
        drawIcon(surface, icon, {x: left + 22, y: ROW_Y, size: 44, color})
        const temperature = numericAttribute(weather, 'temperature')
        if (temperature !== undefined) {
            drawText(surface, `${Math.round(temperature)}°`, {x: left + 52, y: ROW_Y, size: 30, color: TEMPERATURE_COLOR, align: 'left'})
        }
    }
}
