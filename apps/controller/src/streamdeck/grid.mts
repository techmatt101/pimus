// The physical panel is a 4x2 grid addressed by the deck's key indices:
//
//     [ 0 ][ 1 ][ 2 ][ 3 ]
//     [ 4 ][ 5 ][ 6 ][ 7 ]

import type {Dial} from './dial.mjs'
import type {TouchStrip} from './strip.mjs'
import type {Tile} from './tile.mjs'

export type PageRow = [Tile | null, Tile | null, Tile | null, Tile | null]

export type PageGrid = [PageRow, PageRow]

export function tileAt(grid: PageGrid, index: number): Tile | undefined {
    const row = grid[Math.floor(index / 4)]
    return row?.[index % 4] ?? undefined
}

export interface StreamDeckPage {
    name: string
    grid: PageGrid
}

export interface StreamDeckLayout {
    pages: StreamDeckPage[]
    dials: Dial[]
    strip: TouchStrip
}
