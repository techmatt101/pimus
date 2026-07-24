// The Screen contract: one full-width face for the Stream Deck+ touch strip,
// the dial equivalent of a Tile. A screen owns how it paints the whole 800x100
// strip and may run the same mount/unmount lifecycle a tile does; which screen
// is showing at any moment is decided by the TouchStrip (streamdeck/strip.mts).
//
// The strip is one display, not four dial labels: what is playing belongs
// across the whole width, and a dial being turned or a notification arriving
// takes the width over for as long as it is relevant.

import { bar, BOLD, measureText, text, type Surface } from '../surface.mjs'

/** The touch strip's pixel size, shared by every screen that draws on it. */
export const STRIP_WIDTH = 800
export const STRIP_HEIGHT = 100
/** Left and right breathing room, so nothing sits against the bezel. */
export const STRIP_MARGIN = 24

/** How fast an overlong line slides across the strip. */
const SCROLL_PIXELS_PER_SECOND = 55
/** The clear space between the end of a scrolling line and its repeat. */
const SCROLL_GAP = 80
/** Repaint interval while something on the strip is scrolling. */
export const SCROLL_FRAME_MILLISECONDS = 80

/** What a mounted screen may ask of the strip. */
export interface ScreenHost {
  /** Repaint the strip, outside the shared render schedule. */
  invalidate(): void
}

export interface Screen {
  /**
   * Paint the 800x100 strip face. A screen reads whatever it draws from
   * directly — the injected Home Assistant, its clock, or a subject the strip
   * set on it (which dial is being turned, which notification is up) — rather
   * than being handed a context. `deltaTime` is the milliseconds since the strip
   * last drew, there for parity with a tile; a screen whose motion is a scroll
   * or a draining timer reads its clock instead.
   */
  draw(surface: Surface, deltaTime: number): void
  /**
   * How often to repaint while this screen is the visible one, or undefined
   * when its face is static. Scrolling text is the usual reason; deriving the
   * offset from the injected clock keeps drawing a pure function of the clock.
   */
  animationMilliseconds?(): number | undefined
  /** Called when the strip is showing on an attached deck. */
  mount?(host: ScreenHost): void
  /** Called when the deck disconnects. */
  unmount?(): void
}

export interface StripLineOptions {
  /** The vertical centre of the line. */
  centerY: number
  size: number
  color?: string
  /** The instant of this repaint, which is what moves a scrolling line. */
  now?: number
  margin?: number
  /** Left-align rather than centre, for a line that shares a row with something else. */
  left?: number
  opacity?: number
  weight?: number
}

/**
 * One line of text across the strip: centred while it fits, and sliding
 * leftwards when it does not, so a long song title is read in full rather than
 * truncated. Returns whether it is scrolling, which is how a screen decides to
 * ask for animation frames.
 */
export function drawStripLine(surface: Surface, value: string, options: StripLineOptions): boolean {
  const { centerY, size, color = '#ffffff', now = 0, margin = STRIP_MARGIN, left, opacity, weight = BOLD } = options
  const available = surface.width - margin - (left ?? margin)
  // Measured at the weight it will be drawn in, or a lighter line would be
  // judged to overflow — and scroll — at a width it actually fits.
  const width = measureText(value, size, weight)
  const line = { y: centerY, size, color, opacity, weight, align: 'left' as const }

  if (width <= available) {
    const x = left ?? Math.round((surface.width - width) / 2)
    text(surface, value, { ...line, x })
    return false
  }

  // The line and one repeat of it slide together, so the text runs continuously
  // instead of restarting from an empty strip every cycle. Anything outside the
  // strip is clipped by the surface, so both copies are simply drawn.
  const cycle = width + SCROLL_GAP
  const offset = ((now / 1000) * SCROLL_PIXELS_PER_SECOND) % cycle
  const start = (left ?? margin) - offset
  text(surface, value, { ...line, x: start })
  text(surface, value, { ...line, x: start + cycle })
  return true
}

/**
 * Whether `value` is too wide for the strip and would therefore scroll. A
 * screen asks this to decide whether it needs animation frames, without having
 * to paint a face to find out.
 */
export function overflows(value: string, size: number, margin = STRIP_MARGIN): boolean {
  return measureText(value, size) > STRIP_WIDTH - margin * 2
}

/**
 * A progress bar along the bottom edge: playback position, a dial's level, or a
 * notification's remaining time. `fraction` is clamped, so an out-of-range
 * reading draws a full or empty bar rather than running off the strip.
 */
export function drawStripBar(
  surface: Surface,
  fraction: number,
  { color = '#26c6da', track = '#1c2b33', height = 6 }: { color?: string; track?: string; height?: number } = {},
): void {
  bar(surface, fraction, {
    x: 0,
    y: surface.height - height,
    width: surface.width,
    height,
    color,
    track,
  })
}
