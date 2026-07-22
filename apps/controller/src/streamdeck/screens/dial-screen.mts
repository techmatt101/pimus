// What the strip shows while a dial is being turned or pressed: that one dial,
// across the full width, instead of four columns of labels nobody reads while
// their hand is on a knob. The strip goes back to what is playing a couple of
// seconds after the last movement (streamdeck/strip.mts).
//
// The readout itself follows the actions bound to the dial rather than its
// position, so reordering the dials in layout.mts keeps each one correct; a dial
// that knows something the actions cannot express supplies its own `detail`, and
// one with a level supplies `level` for the bar.

import {
  createStrip,
  drawStripBar,
  drawStripLine,
  fittingScale,
  type Screen,
  type ScreenContext,
} from './screen.mjs'
import type { StreamDeckDial } from '../grid.mjs'
import type { TileContext } from '../tiles/tile.mjs'
import type { Bitmap } from '../../types.mjs'

/** Readout scales tried in turn, so `67%` is drawn far larger than `DISCONNECTED`. */
const VALUE_SCALES = [7, 5, 4, 3]
const LABEL_SCALE = 2
const LABEL_COLOR = '#80deea'

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
  render(context: ScreenContext): Bitmap {
    const dial = context.dial
    const face = createStrip('#16222b')
    if (!dial) return face

    const value = dialDetail(context, dial)
    drawStripLine(face, dial.label, { centerY: 22, scale: LABEL_SCALE, color: LABEL_COLOR, now: context.now })
    drawStripLine(face, value, { centerY: 58, scale: fittingScale(value, VALUE_SCALES), now: context.now })

    const level = dialLevel(context, dial)
    if (level !== undefined) drawStripBar(face, level, { color: '#26c6da', track: '#22333d' })
    return face
  }
}
