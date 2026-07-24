import type {Binding} from '../bindings.mjs'
import type {Dial} from '../dial.mjs'

export interface PageNavigator {
    /** Move by whole pages, wrapping around at either end. */
    changePage(delta: number): void

    currentName(): string
}

const IDLE_DETAIL = 'PAGE'

/**
 * Turning it pages the key grid. Paging lives on the renderer, which is built
 * after the layout, so the dial is handed a navigator once the renderer exists;
 * until then its turns are harmless no-ops.
 */
export class PageDial implements Dial {
    readonly label = 'PAGE'
    readonly left: Binding
    readonly right: Binding
    #nav: PageNavigator | null = null

    constructor() {
        this.left = {action: {type: 'noop'}, run: () => this.#nav?.changePage(-1)}
        this.right = {action: {type: 'noop'}, run: () => this.#nav?.changePage(1)}
    }

    connect(nav: PageNavigator): void {
        this.#nav = nav
    }

    detail(): string {
        return this.#nav?.currentName() || IDLE_DETAIL
    }
}
