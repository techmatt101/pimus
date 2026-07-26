import {requireEntity} from '../../actions/catalog.mjs'
import {numericAttribute} from '../../home-assistant/entity.mjs'
import {conditionIcon} from '../icons.mjs'
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
    /** The `weather.` entity shown beside the clock; omitting it leaves the clock alone. */
    weatherEntityId?: string
    clockFormat?: ClockFormat
}

const STATUS_X = 44
const STATUS_SIZE = 24
const STATUS_GAP = 12

/** The strip's resting face when nothing is playing: a clock, with the weather beside it. */
export class IdleScreen implements Screen {
    readonly #ha: HomeAssistantService
    readonly #model: ControlModel
    readonly #clock: () => number
    readonly #weather: string | undefined
    readonly #clockFormat: ClockFormat
    #unwatch: (() => void) | null = null

    constructor(ha: HomeAssistantService, model: ControlModel, clock: () => number, {weatherEntityId, clockFormat = '24h'}: IdleScreenOptions) {
        this.#ha = ha
        this.#model = model
        this.#clock = clock
        this.#weather = weatherEntityId ? requireEntity(weatherEntityId, 'idle screen') : undefined
        this.#clockFormat = clockFormat
    }

    mount(host: ScreenHost): void {
        this.#unwatch = this.#weather
            ? this.#ha.watch([this.#weather], () => host.invalidate())
            : null
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
    }

    animationMilliseconds(): number {
        const tick = minuteTick(this.#clock())
        return hasFault(this.#model.state) ? Math.min(tick, STATUS_FLASH_FRAME_MILLISECONDS) : tick
    }

    draw(surface: Surface): void {
        surface.fill(BACKDROP)
        const now = this.#clock()
        const clock = drawClock(surface, now, this.#clockFormat, {centerX: STRIP_WIDTH / 2, y: ROW_Y, size: TIME_SIZE, color: TIME_COLOR})
        const date = formatDate(now)
        const dateLeft = clock.right + DATE_GAP
        drawText(surface, date, {x: dateLeft, y: ROW_Y, size: DATE_SIZE, color: DATE_COLOR, align: 'left'})
        this.#drawWeather(surface, dateLeft + measureText(date, DATE_SIZE) + WEATHER_GAP)
        drawStatusIcons(surface, this.#model.state, {x: STATUS_X, y: ROW_Y, size: STATUS_SIZE, gap: STATUS_GAP, now})
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
