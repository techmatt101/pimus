import {fittingSize, type Surface, verticalGradient} from '../surface.mjs'
import {drawStripBar, drawStripLine, type Screen, STRIP_MARGIN, STRIP_WIDTH,} from './screen.mjs'
import type {Dial} from '../dial.mjs'

const VALUE_SIZES = [76, 60, 48, 36]
const LABEL_SIZE = 24
const LABEL_COLOR = '#80deea'
const BACKDROP = ['#1d2d38', '#101a21'] as const

/** The one face all four dials share; the strip calls `show` before drawing. */
export class DialScreen implements Screen {
    #dial: Dial | undefined
    readonly #clock: () => number

    constructor(clock: () => number) {
        this.#clock = clock
    }

    show(dial: Dial): void {
        this.#dial = dial
    }

    draw(surface: Surface): void {
        surface.fill(verticalGradient(surface, BACKDROP[0], BACKDROP[1]))
        const dial = this.#dial
        if (!dial) return

        const now = this.#clock()
        const value = dial.detail()
        drawStripLine(surface, dial.label, {
            centerY: 22,
            size: LABEL_SIZE,
            color: LABEL_COLOR,
            now,
        })
        drawStripLine(surface, value, {
            centerY: 58,
            size: fittingSize(value, VALUE_SIZES, STRIP_WIDTH - STRIP_MARGIN * 2),
            now,
        })

        const level = dial.level?.()
        if (level !== undefined) drawStripBar(surface, level, {color: '#26c6da', track: '#22333d'})
    }
}
