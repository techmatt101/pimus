import type { StreamDeck } from '@elgato-stream-deck/node'

import { PageDial, type PageNavigator } from './dials/page-dial.mjs'
import {
  tileAt,
  type StreamDeckLayout,
  type StreamDeckPage,
} from './grid.mjs'
import { STRIP_HEIGHT, STRIP_WIDTH } from './screens/screen.mjs'
import { Surface } from './surface.mjs'
import {
  KEY_SIZE,
  type Tile,
  type TileHost,
} from './tiles/tile.mjs'
import type { ControlModel } from '../state.mjs'

/** Every face is written to the device in the format a canvas produces. */
const FORMAT = { format: 'rgba' } as const

export interface DeckRendererOptions {
  layout: StreamDeckLayout
  model: ControlModel
  logger?: Pick<Console, 'error'>
}

export class DeckRenderer implements PageNavigator {
  readonly layout: StreamDeckLayout
  private readonly model: ControlModel
  private readonly logger: Pick<Console, 'error'>
  // Null until a deck is attached; LED-only deployments never attach one, so
  // render is a no-op there without any special-casing of the layout.
  private deck: StreamDeck | null = null
  // Whether the panel is switched off because the room is empty
  // (streamdeck/sleep.mts). Asleep is deliberately the same shape as having no
  // deck attached: nothing mounted, no timers, nothing written.
  private asleep = false
  private renderPending = false
  // The brightness last written to the panel, so a stream of unrelated state
  // changes does not re-issue the same setBrightness; null until one is written.
  private lastBrightness: number | null = null
  // Which page of the key grid is showing. The dials are unaffected by paging.
  private pageIndex = 0
  // The tiles of the current page, mounted while a deck is attached, keyed by
  // physical key index. Mounted tiles may hold model subscriptions and
  // animation timers, so every path that hides a tile must unmount it.
  private readonly mounted = new Map<number, Tile>()
  // One surface per size, reused for every face rather than allocated per
  // frame: a key repaints as often as its animation asks it to, and a canvas
  // carries a Skia context that is not worth rebuilding sixty times a second.
  private readonly keySurface = new Surface(KEY_SIZE, KEY_SIZE)
  private readonly stripSurface = new Surface(STRIP_WIDTH, STRIP_HEIGHT)
  // The clock each paint is stamped with, so a face is handed the milliseconds
  // since it last drew — its deltaTime — for whatever it animates.
  private readonly now: () => number = Date.now
  // When each key and the strip last drew, to derive that delta. A key absent
  // from the map is drawing for the first time since it was mounted, so its
  // delta is zero rather than the whole span the deck spent on another page.
  private readonly lastKeyDrawAt = new Map<number, number>()
  private lastStripDrawAt = 0

  constructor({ layout, model, logger = console }: DeckRendererOptions) {
    this.layout = layout
    this.model = model
    this.logger = logger
    this.asleep = !model.state.awake
    // The renderer owns paging, so it hands its paging to any page-switcher dial
    // in the layout. The dial is built before the renderer and reaches it here.
    for (const dial of layout.dials) if (dial instanceof PageDial) dial.connect(this)
    this.model.subscribe(() => {
      const wasAsleep = this.asleep
      void this.applyAwake()
      // A sleep/wake transition brightens the panel in careful order inside
      // applyAwake (paint first, then light); a plain brightness change with the
      // panel staying up is all that is left for this path to apply.
      if (!this.asleep && this.asleep === wasAsleep) void this.applyBrightness()
      this.schedule()
    })
  }

  /**
   * Take over an attached deck: mount what is visible, paint it, then bring the
   * panel up. Brightness is set here rather than by the deck loop so one object
   * owns every write to the panel, including a deck that reconnects while the
   * room is empty and has to come back dark.
   */
  async setDeck(deck: StreamDeck): Promise<void> {
    this.deck = deck
    this.asleep = !this.model.state.awake
    if (!this.asleep) this.mountVisible()
    await this.render()
    await this.applyBrightness()
  }

  clearDeck(deck: StreamDeck | null): void {
    if (this.deck !== deck) return
    this.deck = null
    this.unmountVisible()
  }

  /**
   * Follow `state.awake`. Going dark switches the panel off before dropping the
   * tiles, so the last thing seen is never a face frozen mid-animation; waking
   * paints the whole panel first, because the deck retains its last image and
   * raising the brightness onto a stale one shows a flash of the old room.
   */
  private async applyAwake(): Promise<void> {
    const asleep = !this.model.state.awake
    if (asleep === this.asleep) return
    this.asleep = asleep
    if (!this.deck) return
    if (asleep) {
      await this.applyBrightness()
      this.unmountVisible()
    } else {
      this.mountVisible()
      await this.render()
      await this.applyBrightness()
    }
  }

  /** Mount the visible page's tiles and the strip, which is not paged. */
  private mountVisible(): void {
    this.mountPage()
    // The strip mounts with the deck and stays up, so what is playing keeps
    // scrolling whichever page of keys is showing.
    this.layout.strip.mount({ invalidate: () => void this.renderStrip() })
  }

  private unmountVisible(): void {
    this.unmountPage()
    this.layout.strip.unmount()
  }

  /**
   * Panel brightness for the current state: the model's, or off while asleep.
   * Idempotent — it skips a write that would set the level already showing — so
   * both the sleep/wake path and a BrightnessTile press can call it freely.
   */
  private async applyBrightness(): Promise<void> {
    const deck = this.deck
    if (!deck) return
    const target = this.asleep ? 0 : this.model.state.brightness
    if (target === this.lastBrightness) return
    this.lastBrightness = target
    try {
      await deck.setBrightness(target)
    } catch (error) {
      // Leave the panel able to retry: the level did not take, so do not record it.
      this.lastBrightness = null
      this.logger.error('brightness failed', error)
    }
  }

  /**
   * Report a dial being turned or pressed, so the strip shows that dial's
   * readout for a moment before going back to what is playing.
   */
  showDial(index: number): void {
    this.layout.strip.showDial(index)
  }

  /**
   * A thunk that presses the strip at `x`, or undefined when the press was
   * consumed — acknowledging a notification — or lands on an unbound dial.
   */
  stripPressAt(x: number): (() => unknown) | undefined {
    return this.layout.strip.pressAt(x)
  }

  /** The page currently showing, or undefined if the layout carries none. */
  private currentPage(): StreamDeckPage | undefined {
    return this.layout.pages[this.pageIndex]
  }

  /** PageNavigator: the name of the page showing, for a page-switcher dial. */
  currentName(): string {
    return this.pageNameAt(0)
  }

  /** The milliseconds since a key last drew, stamping it as having drawn at `at`. */
  private keyDelta(index: number, at: number): number {
    const last = this.lastKeyDrawAt.get(index)
    this.lastKeyDrawAt.set(index, at)
    return last === undefined ? 0 : at - last
  }

  /** The milliseconds since the strip last drew, stamping it as having drawn at `at`. */
  private stripDelta(at: number): number {
    const last = this.lastStripDrawAt
    this.lastStripDrawAt = at
    return last === 0 ? 0 : at - last
  }

  /**
   * A thunk that presses the tile at a physical key, or undefined for a nav
   * corner or empty slot. Returning a thunk rather than pressing immediately
   * lets the deck's dispatch queue keep presses in physical order.
   */
  pressAt(index: number): (() => unknown) | undefined {
    const page = this.currentPage()
    const tile = page ? tileAt(page.grid, index) : undefined
    if (!tile) return undefined
    return () => tile.press()
  }

  /** Move by whole pages, wrapping around at either end, then repaint. */
  changePage(delta: number): void {
    const count = this.layout.pages.length
    if (count === 0) return
    this.pageIndex = (((this.pageIndex + delta) % count) + count) % count
    this.mountPage()
    void this.render()
  }

  /** Mount the visible page's tiles, unmounting whatever was showing before. */
  private mountPage(): void {
    this.unmountPage()
    if (!this.deck) return
    const page = this.currentPage()
    if (!page) return
    for (let index = 0; index < 8; index += 1) {
      const tile = tileAt(page.grid, index)
      if (!tile) continue
      this.mounted.set(index, tile)
      tile.mount?.(this.hostFor(index))
    }
  }

  /** What a mounted tile is allowed to ask of this renderer. */
  private hostFor(index: number): TileHost {
    return {
      invalidate: () => void this.renderKey(index),
      changePage: (delta) => this.changePage(delta),
      pageName: (delta) => this.pageNameAt(delta),
    }
  }

  /** The name of the page `delta` steps from the current one, wrapping around. */
  private pageNameAt(delta: number): string {
    const count = this.layout.pages.length
    if (count === 0) return ''
    return this.layout.pages[(((this.pageIndex + delta) % count) + count) % count]?.name ?? ''
  }

  private unmountPage(): void {
    for (const tile of this.mounted.values()) tile.unmount?.()
    this.mounted.clear()
    // The next page's keys draw fresh, so an animated one starts from a zero
    // delta rather than the whole time this page was up.
    this.lastKeyDrawAt.clear()
  }

  /**
   * Repaint a single mounted tile, on its own request. Animations run through
   * here so a pulsing key repaints without redrawing the whole panel.
   */
  private async renderKey(index: number): Promise<void> {
    const deck = this.deck
    const tile = this.mounted.get(index)
    if (!deck || !tile || this.asleep) return
    try {
      await deck.fillKeyBuffer(index, this.paintTile(tile, this.keyDelta(index, this.now())), FORMAT)
    } catch (error) {
      this.logger.error('render failed', error)
    }
  }

  /**
   * Repaint just the touch strip, on its own request. Scrolling text and a
   * draining notification go through here so the strip animates without
   * redrawing all eight keys behind it.
   */
  private async renderStrip(): Promise<void> {
    const deck = this.deck
    if (!deck || this.asleep) return
    try {
      await deck.fillLcd(0, this.paintStrip(this.stripDelta(this.now())), FORMAT)
    } catch (error) {
      this.logger.error('render failed', error)
    }
  }

  schedule(): void {
    if (this.renderPending || this.asleep) return
    this.renderPending = true
    setTimeout(() => void this.render(), 50)
  }

  async render(): Promise<void> {
    this.renderPending = false
    const deck = this.deck
    if (!deck || this.asleep) return
    try {
      const at = this.now()
      const page = this.currentPage()
      // Draw all eight keys: the deck retains its last image, so a blank slot or
      // a tile each has to be painted every time.
      for (let index = 0; index < 8; index += 1) {
        const tile = page ? tileAt(page.grid, index) : undefined
        await deck.fillKeyBuffer(index, this.paintTile(tile, this.keyDelta(index, at)), FORMAT)
      }

      await deck.fillLcd(0, this.paintStrip(this.stripDelta(at)), FORMAT)
    } catch (error) {
      this.logger.error('render failed', error)
    }
  }

  /**
   * Paint a key face and take a copy of it. The surface is cleared first, so a
   * tile only draws what it wants to show, and an empty slot is simply the
   * cleared surface — the deck retains its last image, so every key has to be
   * written on every full render.
   */
  private paintTile(tile: Tile | undefined, deltaTime: number): Buffer {
    this.keySurface.reset()
    tile?.draw(this.keySurface, deltaTime)
    return this.keySurface.snapshot()
  }

  private paintStrip(deltaTime: number): Buffer {
    this.stripSurface.reset()
    this.layout.strip.draw(this.stripSurface, deltaTime)
    return this.stripSurface.snapshot()
  }
}
