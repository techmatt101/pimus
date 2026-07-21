import type { StreamDeck } from '@elgato-stream-deck/node'

import { createImage, drawRectangle, drawText } from './bitmap.mjs'
import { NEXT_KEY, PREV_KEY, tileAt, type StreamDeckLayout, type StreamDeckPage } from './grid.mjs'
import { labelTile, type TileContext } from './tile.mjs'
import type { Action, AudioState, ControlState, StreamDeckDial } from '../types.mjs'

/** Background colour of the previous/next navigation keys. */
const NAV_COLOR = '#263238'

/**
 * The value line under a dial's label. What a dial reports follows from the
 * actions bound to it rather than its position, so reordering the dials in
 * layout.mts keeps each dial's readout correct.
 */
export function dialDetail(
  state: ControlState,
  audioState: AudioState = { sources: {} },
  dial?: StreamDeckDial,
): string {
  const actions = [dial?.press, dial?.left, dial?.right]
  const source = actions.find((action) => action?.source)?.source
  if (source) return audioState.sources[source] ? 'ON' : 'OFF'
  if (actions.some((action) => action?.type === 'audio' && !action.source)) {
    return state.outputMuted ? 'MUTED' : `${Math.round(state.volume * 100)}%`
  }
  return String(state.assist)
}

export interface DeckRendererOptions {
  layout: StreamDeckLayout
  state: ControlState
  readAudioState: () => AudioState
  logger?: Pick<Console, 'error'>
}

export class DeckRenderer {
  readonly layout: StreamDeckLayout
  readonly state: ControlState
  private readonly readAudioState: () => AudioState
  private readonly logger: Pick<Console, 'error'>
  // Null until a deck is attached; LED-only deployments never attach one, so
  // render is a no-op there without any special-casing of the layout.
  private deck: StreamDeck | null = null
  private renderPending = false
  // Which page of the key grid is showing. The dials are unaffected by paging.
  private pageIndex = 0

  constructor({ layout, state, readAudioState, logger = console }: DeckRendererOptions) {
    this.layout = layout
    this.state = state
    this.readAudioState = readAudioState
    this.logger = logger
  }

  setDeck(deck: StreamDeck): void {
    this.deck = deck
  }

  clearDeck(deck: StreamDeck | null): void {
    if (this.deck === deck) this.deck = null
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

  /** Live state passed to each tile so it can pick its face and action. */
  private context(): TileContext {
    return { state: this.state, audio: this.readAudioState() }
  }

  /** The action the tile at a physical key would dispatch, if any. */
  actionAt(index: number): Action | undefined {
    if (this.navTarget(index)) return undefined
    const page = this.currentPage()
    if (!page) return undefined
    return tileAt(page.grid, index)?.action(this.context())
  }

  /** Move by whole pages, wrapping around at either end, then repaint. */
  changePage(delta: number): void {
    const count = this.layout.pages.length
    if (count === 0) return
    this.pageIndex = (((this.pageIndex + delta) % count) + count) % count
    void this.render()
  }

  schedule(): void {
    if (this.renderPending) return
    this.renderPending = true
    setTimeout(() => void this.render(), 50)
  }

  async render(): Promise<void> {
    this.renderPending = false
    const deck = this.deck
    if (!deck) return
    const layout = this.layout
    try {
      const context = this.context()
      const page = this.currentPage()
      // Draw all eight keys: the deck retains its last image, so a nav corner,
      // a blank slot, or a tile each has to be painted every time.
      for (let index = 0; index < 8; index += 1) {
        const nav = this.navTarget(index)
        if (nav) {
          await deck.fillKeyBuffer(index, labelTile(NAV_COLOR, this.navLabel(nav)).buffer, { format: 'rgb' })
          continue
        }
        const tile = page ? tileAt(page.grid, index) : undefined
        const face = tile ? tile.render(context) : createImage(120, 120, '#000000')
        await deck.fillKeyBuffer(index, face.buffer, { format: 'rgb' })
      }

      const lcd = createImage(800, 100, '#101820')
      layout.dials.slice(0, 4).forEach((dial, index) => {
        drawRectangle(lcd, index * 200 + 1, 1, 198, 98, index % 2 ? '#17242d' : '#101820')
        drawText(lcd, dial.label, index * 200 + 100, 30, 3, '#80deea')
        const detail = dialDetail(this.state, context.audio, dial).slice(0, 12)
        drawText(lcd, detail, index * 200 + 100, 70, detail.length > 8 ? 2 : 3)
      })
      await deck.fillLcd(0, lcd.buffer, { format: 'rgb' })
    } catch (error) {
      this.logger.error('render failed', error)
    }
  }

  /** An arrow plus the name of the page a nav key would move to. */
  private navLabel(direction: 'prev' | 'next'): string {
    const count = this.layout.pages.length
    const delta = direction === 'next' ? 1 : -1
    const name = this.layout.pages[(((this.pageIndex + delta) % count) + count) % count]?.name ?? ''
    return direction === 'next' ? `${name} >`.trim() : `< ${name}`.trim()
  }
}
