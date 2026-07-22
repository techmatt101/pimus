// A message pushed from Home Assistant, taking the strip for as long as it is
// live: the doorbell, the washing machine, anything an automation wants the room
// to know. The queue and the timing belong to home-assistant/notifications.mts;
// this is only what one looks like.
//
// The banner keeps its own colour so a glance tells the doorbell from the
// laundry, and drains a bar as its time runs out so it is obvious the strip is
// about to go back to what is playing rather than having got stuck.

import { fittingSize, lighten, type Surface } from '../surface.mjs'
import {
  drawStripBar,
  drawStripLine,
  STRIP_MARGIN,
  STRIP_WIDTH,
  type Screen,
  type ScreenContext,
} from './screen.mjs'

/** Message sizes tried in turn; a long message scrolls at the smallest. */
const MESSAGE_SIZES = [56, 46, 36]
const TITLE_SIZE = 24
const TITLE_COLOR = '#eceff1'
/** Repaint rate while a banner is up, which is what drains its time bar. */
const DRAIN_FRAME_MILLISECONDS = 250

export class NotificationScreen implements Screen {
  animationMilliseconds({ notification }: ScreenContext): number | undefined {
    return notification ? DRAIN_FRAME_MILLISECONDS : undefined
  }

  draw(surface: Surface, { notification, now }: ScreenContext): void {
    if (!notification) {
      surface.fill('#101820')
      return
    }

    const { title, message, color } = notification
    // Lit from the top like a key face, so a banner arriving reads as the strip
    // lighting up rather than as a flat colour swap.
    surface.fill(surface.verticalGradient(lighten(color, 0.22), color))

    if (title) {
      drawStripLine(surface, title, { centerY: 24, size: TITLE_SIZE, color: TITLE_COLOR, now })
    }
    drawStripLine(surface, message, {
      centerY: title ? 58 : 46,
      size: fittingSize(message, MESSAGE_SIZES, STRIP_WIDTH - STRIP_MARGIN * 2),
      now,
    })

    // Time bar: full when it arrives, empty as it hands the strip back. Its
    // track is the banner colour, so only the time left is drawn.
    const total = Math.max(1, notification.expiresAt - notification.shownAt)
    drawStripBar(surface, (notification.expiresAt - now) / total, {
      color: TITLE_COLOR,
      track: color,
    })
  }
}
