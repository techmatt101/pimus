// A read-only key: whatever a Home Assistant temperature sensor currently says.
// Pressing it does nothing on purpose — a key that both displays and acts is
// one you cannot glance at without worrying you have nudged something.

import { requireEntity } from '../../actions/catalog.mjs'
import { numericState } from '../../home-assistant/entity.mjs'
import { bar, fittingSize, icon, text, type Surface } from '../surface.mjs'
import { drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost } from './tile.mjs'
import type { TileServices } from '../bindings.mjs'
import type { HomeAssistantService } from '../../types.mjs'

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

const ICON_X = 30
const ICON_SIZE = 46
/** The reading sits to the right of the thermometer, in the space that leaves. */
const VALUE_X = 78
const VALUE_WIDTH = 74

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

  draw(surface: Surface): void {
    const sensor = this.ha.entity(this.entity)
    const reading = numericState(sensor)
    if (reading === undefined) {
      drawBackground(surface, '#1a1a1a')
      icon(surface, 'thermometer', { x: ICON_X, y: FACE_CENTER, size: ICON_SIZE, color: '#424242' })
      text(surface, '--', { x: VALUE_X, y: FACE_CENTER, size: 34, color: '#616161' })
      drawCaption(surface, this.config.label)
      return
    }

    const band = BANDS.find(([max]) => reading < max) ?? BANDS[BANDS.length - 1]
    drawBackground(surface, band?.[1] ?? '#1a1a1a')
    const accent = band?.[2] ?? '#ffffff'

    // The glyph is drawn in the band's accent so the key carries the reading in
    // colour as well as digits, and a level bar under it says where in the
    // 5..35°C range that sits.
    icon(surface, 'thermometer', { x: ICON_X, y: FACE_CENTER - 4, size: ICON_SIZE, color: accent })
    bar(surface, scaleOf(reading), {
      x: ICON_X - 18,
      y: 76,
      width: 36,
      height: 5,
      color: accent,
      track: 'rgba(0,0,0,0.45)',
      rounded: true,
    })

    // One decimal place is what a room sensor is worth; anything longer stops
    // fitting beside the thermometer.
    const digits = `${Math.abs(reading) < 100 ? reading.toFixed(1) : Math.round(reading)}°`
    text(surface, digits, {
      x: VALUE_X,
      y: FACE_CENTER,
      size: fittingSize(digits, [40, 34, 28], VALUE_WIDTH),
    })
    drawCaption(surface, this.config.label)
  }
}
