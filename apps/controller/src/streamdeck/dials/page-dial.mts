// The page-switcher dial: turning it pages the key grid, the job the two
// bottom-corner keys used to do. It reads out the page you are on, so the strip
// names where a turn just took you instead of leaving you to count positions.
//
// Paging lives on the renderer (streamdeck/renderer.mts), which is built after
// the layout, so the dial is handed a navigator once that renderer exists — the
// same late-binding the dynamic dial uses to reach the strip. Until then its
// turns are harmless no-ops and it reads a neutral label, so a test that builds
// the layout on its own never has to wire one up.

import type { Binding } from '../bindings.mjs'
import type { Dial } from './dial.mjs'

/** How the page dial reaches paging, once the renderer that owns it exists. */
export interface PageNavigator {
  /** Move by whole pages, wrapping around at either end. */
  changePage(delta: number): void
  /** The name of the page currently showing, for the readout. */
  currentName(): string
}

/** Read before a navigator is connected, so the dial still names itself. */
const IDLE_DETAIL = 'PAGE'

export class PageDial implements Dial {
  readonly label = 'PAGE'
  readonly left: Binding
  readonly right: Binding
  private nav: PageNavigator | null = null

  constructor() {
    // A noop action: paging navigates the surface rather than running a
    // catalogued command, exactly as the old nav corners did. The behaviour is
    // the run(), which reaches the renderer once one is connected.
    this.left = { action: { type: 'noop' }, run: () => this.nav?.changePage(-1) }
    this.right = { action: { type: 'noop' }, run: () => this.nav?.changePage(1) }
  }

  /** Hand the dial the renderer's paging. Wired once the renderer exists. */
  connect(nav: PageNavigator): void {
    this.nav = nav
  }

  detail(): string {
    return this.nav?.currentName() || IDLE_DETAIL
  }
}
