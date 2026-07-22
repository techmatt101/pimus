// The Screen contract: one full-width face for the Stream Deck+ touch strip,
// the dial equivalent of a Tile. A screen owns how it paints the whole 800x100
// strip and may run the same mount/unmount lifecycle a tile does; which screen
// is showing at any moment is decided by the TouchStrip (streamdeck/strip.mts).
//
// The strip is one display, not four dial labels: what is playing belongs
// across the whole width, and a dial being turned or a notification arriving
// takes the width over for as long as it is relevant.

import { createImage, drawRectangle, drawTextAt, textWidth } from '../bitmap.mjs'
import type { TileContext } from '../tiles/tile.mjs'
import type { StreamDeckDial } from '../grid.mjs'
import type { Bitmap, Notification } from '../../types.mjs'

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

/**
 * What a screen consults to paint itself: the same live state a tile gets, plus
 * whichever subject the strip selected it for. `dial` is set only while the
 * dial readout is showing and `notification` only while a banner is, so a
 * screen never has to ask the strip what it is being drawn for.
 */
export interface ScreenContext extends TileContext {
  dial?: StreamDeckDial | undefined
  notification?: Notification | undefined
}

/** What a mounted screen may ask of the strip. */
export interface ScreenHost {
  /** Repaint the strip, outside the shared render schedule. */
  invalidate(): void
}

export interface Screen {
  /** The 800x100 strip face for the current state. */
  render(context: ScreenContext): Bitmap
  /**
   * How often to repaint while this screen is the visible one, or undefined
   * when its face is static. Scrolling text is the usual reason; deriving the
   * offset from `context.now` keeps render a pure function, exactly as an
   * animated tile does.
   */
  animationMilliseconds?(context: ScreenContext): number | undefined
  /** Called when the strip is showing on an attached deck. */
  mount?(host: ScreenHost): void
  /** Called when the deck disconnects. */
  unmount?(): void
}

/** A blank strip-sized image, the starting point for every screen face. */
export function createStrip(background = '#101820'): Bitmap {
  return createImage(STRIP_WIDTH, STRIP_HEIGHT, background)
}

export interface StripLineOptions {
  centerY: number
  scale: number
  color?: string
  /** The instant of this repaint, which is what moves a scrolling line. */
  now?: number
  margin?: number
  /** Left-align rather than centre, for a line that shares a row with something else. */
  left?: number
}

/**
 * One line of text across the strip: centred while it fits, and sliding
 * leftwards when it does not, so a long song title is read in full rather than
 * truncated. Returns whether it is scrolling, which is how a screen decides to
 * ask for animation frames.
 */
export function drawStripLine(target: Bitmap, value: string, options: StripLineOptions): boolean {
  const { centerY, scale, color = '#ffffff', now = 0, margin = STRIP_MARGIN, left } = options
  const available = target.width - margin - (left ?? margin)
  const width = textWidth(value, scale)
  if (width <= available) {
    if (left === undefined) drawTextAt(target, value, Math.round((target.width - width) / 2), centerY, scale, color)
    else drawTextAt(target, value, left, centerY, scale, color)
    return false
  }

  // The line and one repeat of it slide together, so the text runs continuously
  // instead of restarting from an empty strip every cycle.
  const cycle = width + SCROLL_GAP
  const offset = ((now / 1000) * SCROLL_PIXELS_PER_SECOND) % cycle
  const start = (left ?? margin) - offset
  drawTextAt(target, value, start, centerY, scale, color)
  drawTextAt(target, value, start + cycle, centerY, scale, color)
  return true
}

/**
 * Whether `value` is too wide for the strip and would therefore scroll. A
 * screen asks this to decide whether it needs animation frames, without having
 * to paint a face to find out.
 */
export function overflows(value: string, scale: number, margin = STRIP_MARGIN): boolean {
  return textWidth(value, scale) > STRIP_WIDTH - margin * 2
}

/**
 * The largest of `scales` at which `value` fits the strip, or the smallest one
 * offered. A readout picked this way stays as large as it can be without
 * shrinking every value to fit the longest one it might ever show.
 */
export function fittingScale(value: string, scales: readonly number[], margin = STRIP_MARGIN): number {
  const available = STRIP_WIDTH - margin * 2
  const fits = [...scales].sort((a, b) => b - a).find((scale) => textWidth(value, scale) <= available)
  return fits ?? Math.min(...scales)
}

/**
 * A progress bar along the bottom edge: playback position, a dial's level, or a
 * notification's remaining time. `fraction` is clamped, so an out-of-range
 * reading draws a full or empty bar rather than running off the strip.
 */
export function drawStripBar(
  target: Bitmap,
  fraction: number,
  { color = '#26c6da', track = '#1c2b33', height = 6 }: { color?: string; track?: string; height?: number } = {},
): void {
  const top = target.height - height
  drawRectangle(target, 0, top, target.width, height, track)
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * target.width)
  drawRectangle(target, 0, top, filled, height, color)
}
