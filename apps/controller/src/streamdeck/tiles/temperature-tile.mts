// A read-only key: whatever a Home Assistant temperature sensor currently says.
// Pressing it does nothing on purpose — a key that both displays and acts is
// one you cannot glance at without worrying you have nudged something.

import { requireEntity } from '../../actions/catalog.mjs'
import { numericState } from '../../home-assistant/entity.mjs'
import { createImage, drawText } from '../bitmap.mjs'
import { thermometerIcon } from '../icons.mjs'
import { drawCaption, type Tile, type TileHost } from './tile.mjs'
import type { TileServices } from '../bindings.mjs'
import type { Bitmap, HomeAssistantService } from '../../types.mjs'

export interface TemperatureTileConfig {
  label: string
  /** The sensor entity, e.g. `sensor.office_temperature`. */
  entity: string
}

/**
 * Background bands in degrees Celsius, coldest first. Colour carries the
 * reading at a glance; the digits are for when you want the exact figure.
 */
const BANDS: ReadonlyArray<readonly [max: number, background: string, accent: string]> = [
  [16, '#0d2137', '#40c4ff'],
  [19, '#0d2b2e', '#26c6da'],
  [23, '#10281a', '#66bb6a'],
  [26, '#33240b', '#ffb300'],
  [Infinity, '#3a1414', '#ff5252'],
]

/** Where a reading sits on the thermometer, from 5°C empty to 35°C full. */
const scaleOf = (celsius: number): number => (celsius - 5) / 30

export class TemperatureTile implements Tile {
  private readonly ha: HomeAssistantService
  private readonly config: TemperatureTileConfig
  private readonly entity: string
  private unwatch: (() => void) | null = null

  constructor(services: TileServices, config: TemperatureTileConfig) {
    this.ha = services.ha
    this.config = config
    this.entity = requireEntity(config.entity, `${config.label} temperature tile`)
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
    const sensor = this.ha.entity(this.entity)
    const reading = numericState(sensor)
    if (reading === undefined) {
      const unknown = createImage(120, 120, '#1a1a1a')
      thermometerIcon(unknown, 26, 44, '#424242', 0)
      drawText(unknown, '--', 74, 44, 3, '#616161')
      drawCaption(unknown, this.config.label)
      return unknown
    }

    const band = BANDS.find(([max]) => reading < max) ?? BANDS[BANDS.length - 1]
    const face = createImage(120, 120, band?.[1] ?? '#1a1a1a')
    thermometerIcon(face, 26, 44, band?.[2] ?? '#ffffff', scaleOf(reading))

    // One decimal place is what a room sensor is worth; anything longer stops
    // fitting beside the thermometer.
    const digits = `${Math.abs(reading) < 100 ? reading.toFixed(1) : Math.round(reading)}°`
    drawText(face, digits, 76, 44, digits.length > 4 ? 2 : 3)
    drawCaption(face, this.config.label)
    return face
  }
}
