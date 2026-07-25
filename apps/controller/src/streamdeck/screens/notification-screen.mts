import {fittingSize, lighten, type Surface, verticalGradient} from '../surface.mjs'
import {drawStripBar, drawStripLine, type Screen, STRIP_MARGIN, STRIP_WIDTH,} from './screen.mjs'
import type {Notification} from '../../types.mjs'

const MESSAGE_SIZES = [56, 46, 36]
// A title takes the top row, so the message shrinks to sit clear beneath it.
const TITLED_MESSAGE_SIZES = [40, 34, 28]
const TITLE_SIZE = 24
const TITLE_COLOR = '#eceff1'
const DRAIN_FRAME_MILLISECONDS = 250

/** The banner for a pushed notification; the strip calls `show` before drawing. */
export class NotificationScreen implements Screen {
    #notification: Notification | undefined
    readonly #clock: () => number

    constructor(clock: () => number) {
        this.#clock = clock
    }

    show(notification: Notification | undefined): void {
        this.#notification = notification
    }

    animationMilliseconds(): number | undefined {
        return this.#notification ? DRAIN_FRAME_MILLISECONDS : undefined
    }

    draw(surface: Surface): void {
        const notification = this.#notification
        if (!notification) {
            surface.fill('#101820')
            return
        }

        const now = this.#clock()
        const {title, message, color} = notification
        surface.fill(verticalGradient(surface, lighten(color, 0.22), color))

        if (title) {
            drawStripLine(surface, title, {centerY: 24, size: TITLE_SIZE, color: TITLE_COLOR, now})
        }
        drawStripLine(surface, message, {
            centerY: title ? 62 : 46,
            size: fittingSize(message, title ? TITLED_MESSAGE_SIZES : MESSAGE_SIZES, STRIP_WIDTH - STRIP_MARGIN * 2),
            now,
        })

        const total = Math.max(1, notification.expiresAt - notification.shownAt)
        drawStripBar(surface, (notification.expiresAt - now) / total, {
            color: TITLE_COLOR,
            track: color,
        })
    }
}
