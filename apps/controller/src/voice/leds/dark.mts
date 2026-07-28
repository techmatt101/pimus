import type {LedAnimation} from './animation.mjs'

/** Every LED off, and the one face that asks the firmware for its own effect. */
export class Dark implements LedAnimation {
    ring(): null {
        return null
    }
}
