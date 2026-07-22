import type { StreamDeck } from '@elgato-stream-deck/node'

import {
  NEXT_KEY,
  PREV_KEY,
  tileAt,
  type StreamDeckLayout,
  type StreamDeckPage,
} from './grid.mjs'
import { STRIP_HEIGHT, STRIP_WIDTH } from './screens/screen.mjs'
import { Surface } from './surface.mjs'
import {
  drawBackground,
  drawCaption,
  FACE_CENTER,
  KEY_SIZE,
  type Tile,
  type TileContext,
  type TileHost,
} from './tiles/tile.mjs'
import type { ControlModel } from '../state.mjs'

/** Background colour of the previous/next navigation keys. */
const NAV_COLOR = '#263238'
/** Every face is written to the device in the format a canvas produces. */
const FORMAT = { format: 'rgba' } as const

export interface DeckRendererOptions {
  layout: StreamDeckLayout
  model: ControlModel
  logger?: Pick<Console, 'error'>
}

export class DeckRenderer {
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

  constructor({ layout, model, logger = console }: DeckRendererOptions) {
    this.layout = layout
    this.model = model
    this.logger = logger
    this.asleep = !model.state.awake
    this.model.subscribe(() => {
      void this.applyAwake()
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

  /** Panel brightness for the current state: the layout's, or off. */
  private async applyBrightness(): Promise<void> {
    const deck = this.deck
    if (!deck) return
    try {
      await deck.setBrightness(this.asleep ? 0 : this.layout.brightness)
    } catch (error) {
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

  /** Paging is only offered once a layout carries more than one page. */
  private get paged(): boolean {
    return this.layout.pages.length > 1
  }

  /** The page currently showing, or undefined if the layout carries none. */
  private currentPage(): StreamDeckPage | undefined {
    return this.layout.pages[this.pageIndex]
  }

  /**
   * Whether a physical key is a navigation corner, and which way it moves. Only
   * reports a target when paging is active, so single-page layouts dispatch the
   * bottom corners as ordinary blank slots.
   */
  navTarget(index: number): 'prev' | 'next' | undefined {
    if (!this.paged) return undefined
    if (index === PREV_KEY) return 'prev'
    if (index === NEXT_KEY) return 'next'
    return undefined
  }

  /** Live state passed to each tile so it can pick its face and behaviour. */
  private context(): TileContext {
    return { state: this.model.state, audio: this.model.audio, now: Date.now() }
  }

  /**
   * A thunk that presses the tile at a physical key, or undefined for a nav
   * corner or empty slot. Returning a thunk rather than pressing immediately
   * lets the deck's dispatch queue keep presses in physical order.
   */
  pressAt(index: number): (() => unknown) | undefined {
    if (this.navTarget(index)) return undefined
    const page = this.currentPage()
    const tile = page ? tileAt(page.grid, index) : undefined
    if (!tile) return undefined
    return () => tile.press(this.context())
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
      if (this.navTarget(index)) continue
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
      await deck.fillKeyBuffer(index, this.paintTile(tile, this.context()), FORMAT)
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
      await deck.fillLcd(0, this.paintStrip(this.context()), FORMAT)
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
      const context = this.context()
      const page = this.currentPage()
      // Draw all eight keys: the deck retains its last image, so a nav corner,
      // a blank slot, or a tile each has to be painted every time.
      for (let index = 0; index < 8; index += 1) {
        const nav = this.navTarget(index)
        const tile = nav ? undefined : page ? tileAt(page.grid, index) : undefined
        await deck.fillKeyBuffer(index, nav ? this.paintNav(nav) : this.paintTile(tile, context), FORMAT)
      }

      await deck.fillLcd(0, this.paintStrip(context), FORMAT)
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
  private paintTile(tile: Tile | undefined, context: TileContext): Buffer {
    this.keySurface.reset()
    tile?.draw(this.keySurface, context)
    return this.keySurface.snapshot()
  }

  /** A navigation corner: an arrow towards the page it moves to, and its name. */
  private paintNav(direction: 'prev' | 'next'): Buffer {
    const surface = this.keySurface
    surface.reset()
    drawBackground(surface, NAV_COLOR)
    surface.icon(direction === 'next' ? 'next' : 'previous', {
      x: surface.width / 2,
      y: FACE_CENTER,
      size: 48,
      color: '#eceff1',
    })
    drawCaption(surface, this.pageNameAt(direction === 'next' ? 1 : -1))
    return surface.snapshot()
  }

  private paintStrip(context: TileContext): Buffer {
    this.stripSurface.reset()
    this.layout.strip.draw(this.stripSurface, context)
    return this.stripSurface.snapshot()
  }
}
