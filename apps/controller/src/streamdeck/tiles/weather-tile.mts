// The current outdoor conditions from a Home Assistant `weather` entity: a
// condition glyph, a short name for it, and the outside temperature. Read-only
// like the temperature key, so glancing at it cannot change anything.

import { requireEntity } from '../../actions/catalog.mjs'
import { numericAttribute } from '../../home-assistant/entity.mjs'
import { createImage, drawText } from '../bitmap.mjs'
import { drawCondition } from '../icons.mjs'
import { drawCaption, type Tile, type TileHost } from './tile.mjs'
import type { TileServices } from '../bindings.mjs'
import type { Bitmap, HomeAssistantService } from '../../types.mjs'

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
  private readonly ha: HomeAssistantService
  private readonly entity: string
  private readonly label: string
  private unwatch: (() => void) | null = null

  constructor(services: TileServices, { entity, label = 'WEATHER' }: WeatherTileConfig) {
    this.ha = services.ha
    this.entity = requireEntity(entity, 'weather tile')
    this.label = label
  }

  press(): void {}

  mount(host: TileHost): void {
    this.unwatch = this.ha.watch([this.entity], () => host.invalidate())
  }

  unmount(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  render(): Bitmap {
    const weather = this.ha.entity(this.entity)
    if (!weather || weather.state === 'unknown' || weather.state === 'unavailable') {
      const unknown = createImage(120, 120, '#1a1a1a')
      drawCondition(unknown, 60, 40, 'cloudy')
      drawCaption(unknown, this.label)
      return unknown
    }

    const face = createImage(120, 120, '#0e1b26')
    drawCondition(face, 60, 34, weather.state)

    const name = conditionName(weather.state).slice(0, 10)
    drawText(face, name, 60, 78, name.length > 7 ? 1 : 2, '#b0bec5')

    const temperature = numericAttribute(weather, 'temperature')
    drawCaption(face, temperature === undefined ? this.label : `${Math.round(temperature)}°`)
    return face
  }
}
