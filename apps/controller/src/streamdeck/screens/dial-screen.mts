// What the strip shows while a dial is being turned or pressed: that one dial,
// across the full width, instead of four columns of labels nobody reads while
// their hand is on a knob. The strip goes back to what is playing a couple of
// seconds after the last movement (streamdeck/strip.mts).
//
// The four dials share this one face, so a knob's name, reading, and bar all
// come from the dial itself (streamdeck/dials/) rather than being worked out
// here from whatever it happens to be bound to. This screen decides only how
// big each of those is drawn.

import { fittingSize, type Surface } from '../surface.mjs'
import {
  drawStripBar,
  drawStripLine,
  STRIP_MARGIN,
  STRIP_WIDTH,
  type Screen,
  type ScreenContext,
} from './screen.mjs'

/** Readout sizes tried in turn, so `67%` is drawn far larger than `NOT IN USE`. */
const VALUE_SIZES = [76, 60, 48, 36]
const LABEL_SIZE = 24
const LABEL_COLOR = '#80deea'
/** The dial face is washed the same way a key is, so the strip matches the grid. */
const BACKDROP = ['#1d2d38', '#101a21'] as const

/** The one dial the strip is showing. Which dial that is comes from the context. */
export class DialScreen implements Screen {
  draw(surface: Surface, context: ScreenContext): void {
    surface.fill(surface.verticalGradient(BACKDROP[0], BACKDROP[1]))
    const dial = context.dial
    if (!dial) return

    const value = dial.detail(context)
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

    const level = dial.level?.(context)
    if (level !== undefined) drawStripBar(surface, level, { color: '#26c6da', track: '#22333d' })
  }
}
