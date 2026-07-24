import {requireEntity} from '../../actions/catalog.mjs'
import {numericAttribute} from '../../home-assistant/entity.mjs'
import {conditionIcon} from '../icons.mjs'
import {drawIcon, drawText, measureText, type Surface, verticalGradient} from '../surface.mjs'
import {clockTime, minuteTick, type Screen, type ScreenHost, STRIP_WIDTH} from './screen.mjs'
import type {HomeAssistantService} from '../../types.mjs'

const BACKDROP = ['#16222b', '#0b1116'] as const
const TIME_COLOR = '#eceff1'
const TEMPERATURE_COLOR = '#80deea'
const TIME_SIZE = 64
const WEATHER_GAP = 28

export interface IdleScreenOptions {
    /** The `weather.` entity shown beside the clock; omitting it leaves the clock alone. */
    weatherEntityId?: string
}

/** The strip's resting face when nothing is playing: a clock, with the weather beside it. */
export class IdleScreen implements Screen {
    readonly #ha: HomeAssistantService
    readonly #clock: () => number
    readonly #weather: string | undefined
    #unwatch: (() => void) | null = null

    constructor(ha: HomeAssistantService, clock: () => number, {weatherEntityId}: IdleScreenOptions) {
        this.#ha = ha
        this.#clock = clock
        this.#weather = weatherEntityId ? requireEntity(weatherEntityId, 'idle screen') : undefined
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
        return minuteTick(this.#clock())
    }

    draw(surface: Surface): void {
        surface.fill(verticalGradient(surface, BACKDROP[0], BACKDROP[1]))
        const time = clockTime(this.#clock())
        drawText(surface, time, {x: STRIP_WIDTH / 2, y: 50, size: TIME_SIZE, color: TIME_COLOR})
        this.#drawWeather(surface, STRIP_WIDTH / 2 + measureText(time, TIME_SIZE) / 2 + WEATHER_GAP)
    }

    #drawWeather(surface: Surface, left: number): void {
        const weather = this.#weather ? this.#ha.entity(this.#weather) : undefined
        if (!weather || weather.state === 'unknown' || weather.state === 'unavailable') return
        const {icon, color} = conditionIcon(weather.state)
        drawIcon(surface, icon, {x: left + 22, y: 50, size: 44, color})
        const temperature = numericAttribute(weather, 'temperature')
        if (temperature !== undefined) {
            drawText(surface, `${Math.round(temperature)}°`, {x: left + 52, y: 50, size: 30, color: TEMPERATURE_COLOR, align: 'left'})
        }
    }
}
