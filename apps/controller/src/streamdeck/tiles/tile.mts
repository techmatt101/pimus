// The Tile contract: one key on the Stream Deck grid. A tile owns what
// pressing it does and how it paints its own 120x120 face, and may opt into a
// lifecycle for richer behaviour. Each tile class lives in its own file in
// this folder; tiles are created by the layout factory (streamdeck/layout.mts)
// with the controller's services injected, so a tile carries its behaviour
// with it instead of handing a description to a central dispatcher.

import { createImage, drawRectangle, drawText } from '../bitmap.mjs'
import type { Action, AudioState, Bitmap, ControlState } from '../../types.mjs'

/** The live state a tile consults to decide its face and behaviour. */
export interface TileContext {
  state: ControlState
  audio: AudioState
  /**
   * The wall-clock instant of this repaint, for animated faces. Deriving an
   * animation phase from `now` keeps render a pure function of its context —
   * a tile only needs its own timer to *request* repaints (see TileHost).
   */
  now: number
}

/** What a mounted tile may ask of the renderer. */
export interface TileHost {
  /** Repaint just this tile's key face, outside the shared render schedule. */
  invalidate(): void
  /**
   * Move by whole pages, the same as the bottom-corner navigation keys. A tile
   * only ever has a host while it is the visible page, so this is safe to call
   * from a press.
   */
  changePage(delta: number): void
  /** The name of the page `delta` steps away, for a navigation key's face. */
  pageName(delta: number): string
}

/**
 * A key on the grid: what pressing it does, and how it draws itself.
 *
 * `mount` is called when the tile becomes visible on an attached deck, and
 * `unmount` when its page navigates away or the deck disconnects. A tile that
 * keeps its own state may subscribe to the ControlModel in `mount` to react to
 * changes, and drive its own animation by running a timer that calls
 * `host.invalidate()` — it must drop both in `unmount`.
 */
export interface Tile {
  /** Performs the key's behaviour. Runs through the deck's dispatch queue. */
  press(context: TileContext): unknown
  /** The 120x120 key face to show for the current state. */
  render(context: TileContext): Bitmap
  /**
   * The declarative action this tile stands for, if any; layout.test.mts
   * validates it against the catalog. A tile whose behaviour the catalog
   * cannot express omits this or returns undefined.
   */
  action?(): Action | undefined
  /** Called when this tile becomes visible on an attached deck. */
  mount?(host: TileHost): void
  /** Called when the page changes away or the deck disconnects. */
  unmount?(): void
}

/** The standard key face: a centred label over a black caption bar. */
export function labelTile(background: string, label: string): Bitmap {
  const face = createImage(120, 120, background)
  drawCaption(face, label)
  return face
}

/**
 * A readout key: one large value over the caption bar, for tiles that show a
 * measurement rather than a state — the clock, a temperature, a countdown.
 */
export function valueTile(background: string, value: string, caption: string): Bitmap {
  const face = createImage(120, 120, background)
  drawText(face, value, 60, 46, value.length > 5 ? 3 : 4)
  drawCaption(face, caption)
  return face
}

/** The black caption bar every key face shares, so labels line up across the grid. */
export function drawCaption(face: Bitmap, label: string): void {
  drawRectangle(face, 0, 94, 120, 26, '#000000')
  drawText(face, label, 60, 106, label.length > 8 ? 2 : 3)
}
