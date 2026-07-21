// The shape of the paged key grid: where each tile sits and how the physical
// key indices map onto named slots. The physical panel is a 4x2 grid addressed
// by the deck's key indices:
//
//     [ 0 ][ 1 ][ 2 ][ 3 ]
//     [ 4 ][ 5 ][ 6 ][ 7 ]
//
// With more than one page the two bottom corners (4 and 7) become previous/next
// navigation, leaving six slots for a page's tiles. Those six are named so a
// page reads as a fixed grid rather than a count-the-positions array.

import type { Binding } from './bindings.mjs'
import type { Tile, TileContext } from './tiles/tile.mjs'

/** Physical key index of the previous-page corner. */
export const PREV_KEY = 4
/** Physical key index of the next-page corner. */
export const NEXT_KEY = 7

/**
 * A page's tiles by fixed grid position. Every slot is optional; an empty slot
 * renders blank. The two bottom corners are navigation, so the bottom row only
 * exposes its two inner keys:
 *
 *     [ topLeft ][ topMidLeft ][ topMidRight ][ topRight ]
 *     [   nav   ][ bottomLeft ][ bottomRight ][   nav    ]
 */
export interface PageGrid {
  topLeft?: Tile
  topMidLeft?: Tile
  topMidRight?: Tile
  topRight?: Tile
  bottomLeft?: Tile
  bottomRight?: Tile
}

/** Each named slot's physical key index, in reading order. */
const SLOT_INDEX: ReadonlyArray<readonly [keyof PageGrid, number]> = [
  ['topLeft', 0],
  ['topMidLeft', 1],
  ['topMidRight', 2],
  ['topRight', 3],
  ['bottomLeft', 5],
  ['bottomRight', 6],
]

/** The tile at a physical key index, or undefined for a nav corner or empty slot. */
export function tileAt(grid: PageGrid, index: number): Tile | undefined {
  const slot = SLOT_INDEX.find(([, physical]) => physical === index)
  return slot ? grid[slot[0]] : undefined
}

export interface StreamDeckPage {
  /** Shown on the navigation keys so you can see which page you are moving to. */
  name: string
  grid: PageGrid
}

/**
 * One physical dial: a touch-strip label plus the bindings run on
 * counter-clockwise turn, clockwise turn, and press. The bindings' declarative
 * actions also drive the dial's readout (renderer.mts) and layout validation.
 *
 * A dial reporting something the bound actions cannot express — a light's
 * brightness, or which track a player is on — supplies its own `detail`, the
 * dial equivalent of a Tile drawing its own face.
 */
export interface StreamDeckDial {
  label: string
  left?: Binding
  right?: Binding
  press?: Binding
  /** The value line under the label. Falls back to the bound actions' readout. */
  detail?(context: TileContext): string
}

/**
 * The compiled control surface: panel brightness, the paged tile grid, and the
 * persistent dial bindings. The dials are shared across every page; only the
 * grid changes when you navigate.
 */
export interface StreamDeckLayout {
  brightness: number
  pages: StreamDeckPage[]
  dials: StreamDeckDial[]
}
