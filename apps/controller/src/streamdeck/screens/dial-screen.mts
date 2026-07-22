// What the strip shows while a dial is being turned or pressed: that one dial,
// across the full width, instead of four columns of labels nobody reads while
// their hand is on a knob. The strip goes back to what is playing a couple of
// seconds after the last movement (streamdeck/strip.mts).
//
// The readout itself follows the actions bound to the dial rather than its
// position, so reordering the dials in layout.mts keeps each one correct; a dial
// that knows something the actions cannot express supplies its own `detail`, and
// one with a level supplies `level` for the bar.

import { fittingSize, type Surface } from '../surface.mjs'
import {
  drawStripBar,
  drawStripLine,
  STRIP_MARGIN,
  STRIP_WIDTH,
  type Screen,
  type ScreenContext,
} from './screen.mjs'
import type { StreamDeckDial } from '../grid.mjs'
import type { TileContext } from '../tiles/tile.mjs'

/** Readout sizes tried in turn, so `67%` is drawn far larger than `DISCONNECTED`. */
const VALUE_SIZES = [76, 60, 48, 36]
const LABEL_SIZE = 24
const LABEL_COLOR = '#80deea'
/** The dial face is washed the same way a key is, so the strip matches the grid. */
const BACKDROP = ['#1d2d38', '#101a21'] as const

/**
 * The value line for a dial. A dial that knows something the bound actions
 * cannot express — a light's brightness, say — supplies its own `detail`;
 * otherwise the readout follows from the actions bound to it.
 */
export function dialDetail(context: TileContext, dial?: StreamDeckDial): string {
  const own = dial?.detail?.(context)
  if (own !== undefined) return own

  const { state, audio } = context
  const actions = [dial?.press, dial?.left, dial?.right].map((binding) => binding?.action)
  const source = actions.find((action) => action?.source)?.source
  if (source) return audio.sources[source] ? 'ON' : 'OFF'
  if (actions.some((action) => action?.type === 'audio' && !action.source)) {
    return state.outputMuted ? 'MUTED' : `${Math.round(state.volume * 100)}%`
  }
  return String(state.assist)
}

/**
 * The bar under a dial's readout, or undefined for a dial whose value is not a
 * level. A volume or brightness dial reads far faster as a bar than as digits
 * while it is being turned.
 */
export function dialLevel(context: TileContext, dial?: StreamDeckDial): number | undefined {
  const own = dial?.level?.(context)
  if (own !== undefined) return own

  const actions = [dial?.press, dial?.left, dial?.right].map((binding) => binding?.action)
  if (actions.some((action) => action?.type === 'audio' && !action.source)) {
    return context.state.outputMuted ? 0 : context.state.volume
  }
  return undefined
}

/** The one dial the strip is showing. Which dial that is comes from the context. */
export class DialScreen implements Screen {
  draw(surface: Surface, context: ScreenContext): void {
    surface.fill(surface.verticalGradient(BACKDROP[0], BACKDROP[1]))
    const dial = context.dial
    if (!dial) return

    const value = dialDetail(context, dial)
    drawStripLine(surface, dial.label, {
      centerY: 22,
      size: LABEL_SIZE,
      color: LABEL_COLOR,
      now: context.now,
    })
    drawStripLine(surface, value, {
      centerY: 58,
      size: fittingSize(value, VALUE_SIZES, STRIP_WIDTH - STRIP_MARGIN * 2),
      now: context.now,
    })

    const level = dialLevel(context, dial)
    if (level !== undefined) drawStripBar(surface, level, { color: '#26c6da', track: '#22333d' })
  }
}
