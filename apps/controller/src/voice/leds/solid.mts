import type {LedAnimation} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {rgb} from './color.mjs'
import {LED_COUNT} from '../../types.mjs'

/** One steady colour, written once and left alone. */
export class Solid implements LedAnimation {
    readonly color: number

    constructor(color: ColorInput) {
        this.color = rgb(color)
    }

    ring(): readonly number[] {
        return Array<number>(LED_COUNT).fill(this.color)
    }
}
