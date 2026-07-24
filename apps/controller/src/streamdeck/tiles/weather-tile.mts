// The current outdoor conditions from a Home Assistant `weather` entity: a
// condition glyph, a short name for it, and the outside temperature. Read-only
// like the temperature key, so glancing at it cannot change anything.

import {requireEntity} from '../../actions/catalog.mjs'
import {numericAttribute} from '../../home-assistant/entity.mjs'
import {conditionIcon} from '../icons.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawBackground, drawCaption, type Tile, type TileHost} from '../tile.mjs'
import type {TileServices} from '../bindings.mjs'
import type {HomeAssistantService} from '../../types.mjs'

export interface WeatherTileConfig {
    /** The `weather.` entity to read. */
    entity: string
    /** Caption used when the entity is unknown. */
    label?: string
}

/**
 * Short names for Home Assistant's condition strings. Anything not listed falls
 * back to the raw condition with its hyphens stripped, so a condition upstream
 * adds later still labels the key rather than blanking it.
 */
const CONDITION_NAMES: Record<string, string> = {
    'clear-night': 'CLEAR',
    cloudy: 'CLOUDY',
    exceptional: 'ALERT',
    fog: 'FOG',
    hail: 'HAIL',
    lightning: 'STORM',
    'lightning-rainy': 'STORM',
    partlycloudy: 'PART SUN',
    pouring: 'HEAVY RAIN',
    rainy: 'RAIN',
    snowy: 'SNOW',
    'snowy-rainy': 'SLEET',
    sunny: 'SUNNY',
    windy: 'WINDY',
    'windy-variant': 'WINDY',
}

export function conditionName(condition: string): string {
    return CONDITION_NAMES[condition] ?? condition.replace(/-/g, ' ').toUpperCase()
}

export class WeatherTile implements Tile {
    readonly #ha: HomeAssistantService
    readonly #entity: string
    readonly #label: string
    #unwatch: (() => void) | null = null

    constructor(services: TileServices, {entity, label = 'WEATHER'}: WeatherTileConfig) {
        this.#ha = services.ha
        this.#entity = requireEntity(entity, 'weather tile')
        this.#label = label
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
        const x = surface.width / 2
        const weather = this.#ha.entity(this.#entity)
        if (!weather || weather.state === 'unknown' || weather.state === 'unavailable') {
            drawBackground(surface, '#1a1a1a')
            drawIcon(surface, 'cloud', {x, y: 44, size: 54, color: '#424242'})
            drawCaption(surface, this.#label)
            return
        }

        drawBackground(surface, '#0e1b26')
        const {icon: conditionGlyph, color} = conditionIcon(weather.state)
        drawIcon(surface, conditionGlyph, {x, y: 36, size: 52, color})

        const name = conditionName(weather.state)
        drawText(surface, name, {x, y: 76, size: fittingSize(name, [24, 20, 17], 112), color: '#b0bec5'})

        const temperature = numericAttribute(weather, 'temperature')
        drawCaption(surface, temperature === undefined ? this.#label : `${Math.round(temperature)}°`)
    }
}
