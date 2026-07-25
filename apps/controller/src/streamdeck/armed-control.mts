import type {Dial} from './dial.mjs'
import {DynamicDial} from './dials/dynamic-dial.mjs'

/**
 * The "arm the shared dial" active state first grown on the music key, now
 * shared by every key that lends the knob a job. The first press arms the given
 * dial transiently — revealing it on the strip and starting its idle timeout —
 * and the next press, the key or the knob, confirms; turning switches between.
 * A key composes this so the arm / confirm / release plumbing lives in one
 * place, and keeps its own drawing, since only the key knows its face.
 */
export class ArmedControl {
    readonly #dial: DynamicDial
    readonly #control: Dial
    readonly #confirm: () => void

    /** `confirm` owns whether to act-and-release (a picker) or act-and-stay (a live adjuster). */
    constructor(dial: DynamicDial, control: Dial, confirm: () => void) {
        this.#dial = dial
        this.#control = control
        this.#confirm = confirm
    }

    /** Whether the shared dial is armed to this control right now, for the glow. */
    get armed(): boolean {
        return this.#dial.holds(this.#control)
    }

    press(): void {
        if (this.armed) return this.#confirm()
        this.#dial.claim(this.#control, true)
    }

    /** Hand the dial back if we still hold it; call from the key's unmount. */
    release(): void {
        if (this.armed) this.#dial.release()
    }
}
