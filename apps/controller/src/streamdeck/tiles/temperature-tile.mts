import {requireEntity} from '../../actions/catalog.mjs'
import {numericState} from '../../home-assistant/entity.mjs'
import {drawBar, fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import type {HomeAssistantService} from '../../types.mjs'

export interface TemperatureTileConfig {
    label: string
    entity: string
}

/** Background bands in degrees Celsius, coldest first. */
const BANDS: ReadonlyArray<readonly [max: number, background: string, accent: string]> = [
    [16, '#0d2137', '#40c4ff'],
    [19, '#0d2b2e', '#26c6da'],
    [23, '#10281a', '#66bb6a'],
    [26, '#33240b', '#ffb300'],
    [Infinity, '#3a1414', '#ff5252'],
]

/** Where a reading sits on the thermometer, from 5°C empty to 35°C full. */
const scaleOf = (celsius: number): number => (celsius - 5) / 30

const ICON_X = 30
const ICON_SIZE = 46
const VALUE_X = 78
const VALUE_WIDTH = 74

/** A read-only key: pressing it does nothing on purpose. */
export class TemperatureTile implements Tile {
    readonly #ha: HomeAssistantService
    readonly #config: TemperatureTileConfig
    readonly #entity: string
    #unwatch: (() => void) | null = null

    constructor(ha: HomeAssistantService, config: TemperatureTileConfig) {
        this.#ha = ha
        this.#config = config
        this.#entity = requireEntity(config.entity, `${config.label} temperature tile`)
    }

    press(): void {
    }

    mount(host: TileHost): void {
        this.#unwatch = this.#ha.watch([this.#entity], () => host.invalidate())
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
    }

    draw(surface: Surface): void {
        const sensor = this.#ha.entity(this.#entity)
        const reading = numericState(sensor)
        if (reading === undefined) {
            drawBackground(surface, '#1a1a1a')
            drawIcon(surface, 'thermometer', {x: ICON_X, y: FACE_CENTER, size: ICON_SIZE, color: '#424242'})
            drawText(surface, '--', {x: VALUE_X, y: FACE_CENTER, size: 34, color: '#616161'})
            drawCaption(surface, this.#config.label)
            return
        }

        const band = BANDS.find(([max]) => reading < max) ?? BANDS[BANDS.length - 1]
        drawBackground(surface, band?.[1] ?? '#1a1a1a')
        const accent = band?.[2] ?? '#ffffff'

        drawIcon(surface, 'thermometer', {x: ICON_X, y: FACE_CENTER - 4, size: ICON_SIZE, color: accent})
        drawBar(surface, scaleOf(reading), {
            x: ICON_X - 18,
            y: 76,
            width: 36,
            height: 5,
            color: accent,
            track: 'rgba(0,0,0,0.45)',
            rounded: true,
        })

        const digits = `${Math.abs(reading) < 100 ? reading.toFixed(1) : Math.round(reading)}°`
        drawText(surface, digits, {
            x: VALUE_X,
            y: FACE_CENTER,
            size: fittingSize(digits, [40, 34, 28], VALUE_WIDTH),
        })
        drawCaption(surface, this.#config.label)
    }
}
