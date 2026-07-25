import type {Binding} from '../bindings.mjs'
import type {Dial} from '../dial.mjs'

export interface PageNavigator {
    /** Move by whole pages, wrapping around at either end. */
    changePage(delta: number): void

    currentName(): string
}

const IDLE_DETAIL = 'PAGE'

// A quick flick of the knob often lands two or three detents; only the first
// within this window pages, while a sustained turn keeps paging once per window.
const FLICK_ABSORB_MS = 300

/**
 * Turning it pages the key grid. Paging lives on the renderer, which is built
 * after the layout, so the dial is handed a navigator once the renderer exists;
 * until then its turns are harmless no-ops.
 */
export class PageDial implements Dial {
    readonly label = 'PAGE'
    readonly left: Binding
    readonly right: Binding
    readonly #clock: () => number
    #nav: PageNavigator | null = null
    #lastTurnAt = Number.NEGATIVE_INFINITY

    constructor(clock: () => number) {
        this.#clock = clock
        this.left = {action: {type: 'noop'}, run: () => this.#turn(-1)}
        this.right = {action: {type: 'noop'}, run: () => this.#turn(1)}
    }

    #turn(delta: number): void {
        const now = this.#clock()
        if (now - this.#lastTurnAt < FLICK_ABSORB_MS) return
        this.#lastTurnAt = now
        this.#nav?.changePage(delta)
    }

    connect(nav: PageNavigator): void {
        this.#nav = nav
    }

    detail(): string {
        return this.#nav?.currentName() || IDLE_DETAIL
    }
}
