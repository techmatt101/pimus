// The shape of the paged key grid: where each tile sits, as a 2x4 array laid out
// exactly like the panel. The physical panel is a 4x2 grid addressed by the
// deck's key indices:
//
//     [ 0 ][ 1 ][ 2 ][ 3 ]
//     [ 4 ][ 5 ][ 6 ][ 7 ]
//
// Every key is a tile slot. Paging is no longer a pair of corner keys: the
// page-switcher dial (streamdeck/dials/page-dial.mts) moves between pages, so
// all eight keys are free to carry a page's tiles. A page is two rows of four,
// the top row of keys then the bottom, so it reads as the panel does; `null` is
// an empty slot and renders blank.

import type {Dial} from './dial.mjs'
import type {TouchStrip} from './strip.mjs'
import type {Tile} from './tile.mjs'

/** One row of the panel: four key slots, `null` where a key is left blank. */
export type PageRow = [Tile | null, Tile | null, Tile | null, Tile | null]

/** A page's eight keys as the panel's two rows of four. */
export type PageGrid = [PageRow, PageRow]

/** The tile at a physical key index (0-7), or undefined for an empty slot. */
export function tileAt(grid: PageGrid, index: number): Tile | undefined {
    const row = grid[Math.floor(index / 4)]
    return row?.[index % 4] ?? undefined
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
