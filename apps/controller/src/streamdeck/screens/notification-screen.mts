// A message pushed from Home Assistant, taking the strip for as long as it is
// live: the doorbell, the washing machine, anything an automation wants the room
// to know. The queue and the timing belong to home-assistant/notifications.mts;
// this is only what one looks like.
//
// The banner keeps its own colour so a glance tells the doorbell from the
// laundry, and drains a bar as its time runs out so it is obvious the strip is
// about to go back to what is playing rather than having got stuck.

import {
  createStrip,
  drawStripBar,
  drawStripLine,
  fittingScale,
  type Screen,
  type ScreenContext,
} from './screen.mjs'
import type { Bitmap } from '../../types.mjs'

/** Message scales tried in turn; a long message scrolls at the smallest. */
const MESSAGE_SCALES = [5, 4, 3]
const TITLE_SCALE = 2
const TITLE_COLOR = '#eceff1'
/** Repaint rate while a banner is up, which is what drains its time bar. */
const DRAIN_FRAME_MILLISECONDS = 250

export class NotificationScreen implements Screen {
  animationMilliseconds({ notification }: ScreenContext): number | undefined {
    return notification ? DRAIN_FRAME_MILLISECONDS : undefined
  }

  render({ notification, now }: ScreenContext): Bitmap {
    if (!notification) return createStrip()

    const face = createStrip(notification.color)
    const { title, message } = notification
    if (title) {
      drawStripLine(face, title, { centerY: 24, scale: TITLE_SCALE, color: TITLE_COLOR, now })
    }
    drawStripLine(face, message, {
      centerY: title ? 58 : 46,
      scale: fittingScale(message, MESSAGE_SCALES),
      now,
    })

    // Time bar: full when it arrives, empty as it hands the strip back. Its
    // track is the banner colour, so only the time left is drawn.
    const total = Math.max(1, notification.expiresAt - notification.shownAt)
    drawStripBar(face, (notification.expiresAt - now) / total, {
      color: TITLE_COLOR,
      track: notification.color,
    })
    return face
  }
}
