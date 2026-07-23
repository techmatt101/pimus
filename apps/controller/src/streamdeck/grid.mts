// The shape of the paged key grid: where each tile sits and how the physical
// key indices map onto named slots. The physical panel is a 4x2 grid addressed
// by the deck's key indices:
//
//     [ 0 ][ 1 ][ 2 ][ 3 ]
//     [ 4 ][ 5 ][ 6 ][ 7 ]
//
// Every key is a tile slot. Paging is no longer a pair of corner keys: the
// page-switcher dial (streamdeck/dials/page-dial.mts) moves between pages, so
// all eight keys are free to carry a page's tiles. The slots are named so a
// page reads as a fixed grid rather than a count-the-positions array.

import type { Dial } from './dials/dial.mjs'
import type { TouchStrip } from './strip.mjs'
import type { Tile } from './tiles/tile.mjs'

/**
 * A page's tiles by fixed grid position. Every slot is optional; an empty slot
 * renders blank. The two rows mirror each other, so a page reads as a grid:
 *
 *     [ topLeft    ][ topMidLeft    ][ topMidRight    ][ topRight    ]
 *     [ bottomLeft ][ bottomMidLeft ][ bottomMidRight ][ bottomRight ]
 */
export interface PageGrid {
  topLeft?: Tile
  topMidLeft?: Tile
  topMidRight?: Tile
  topRight?: Tile
  bottomLeft?: Tile
  bottomMidLeft?: Tile
  bottomMidRight?: Tile
  bottomRight?: Tile
}

/** Each named slot's physical key index, in reading order. */
const SLOT_INDEX: ReadonlyArray<readonly [keyof PageGrid, number]> = [
  ['topLeft', 0],
  ['topMidLeft', 1],
  ['topMidRight', 2],
  ['topRight', 3],
  ['bottomLeft', 4],
  ['bottomMidLeft', 5],
  ['bottomMidRight', 6],
  ['bottomRight', 7],
]

/** The tile at a physical key index, or undefined for an empty slot. */
export function tileAt(grid: PageGrid, index: number): Tile | undefined {
  const slot = SLOT_INDEX.find(([, physical]) => physical === index)
  return slot ? grid[slot[0]] : undefined
}

export interface StreamDeckPage {
  /** Shown by the page-switcher dial while you turn it, so you see where you land. */
  name: string
  grid: PageGrid
}

/**
 * The compiled control surface: the paged tile grid, the persistent dial
 * bindings, and the touch strip. The dials and the strip are shared across
 * every page; only the grid changes when you navigate. Panel brightness is
 * runtime state on the ControlModel (state.mts), not compiled in here, because
 * the BrightnessTile changes it while the deck is running.
 */
export interface StreamDeckLayout {
  pages: StreamDeckPage[]
  dials: Dial[]
  /** The 800x100 display above the dials, and which screen it shows when. */
  strip: TouchStrip
}
