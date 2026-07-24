// A page-navigation key that can sit in any grid slot, for a page that wants
// its "next" somewhere other than the bottom-right corner the renderer
// reserves. It carries no binding: paging is the renderer's, and a mounted tile
// reaches it through its host — which it only has while it is the visible page,
// exactly when navigating away is meaningful.

import { drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost } from './tile.mjs'
import { icon, type Surface } from '../surface.mjs'

export interface PageTileConfig {
  /** How many pages to move; negative goes back. */
  delta?: number
  /** Caption to use before the tile is mounted and can name the target page. */
  label?: string
  color?: string
}

export class PageTile implements Tile {
  private readonly delta: number
  private readonly label: string
  private readonly color: string
  private host: TileHost | null = null

  constructor({ delta = 1, label = 'PAGE', color = '#263238' }: PageTileConfig = {}) {
    this.delta = delta
    this.label = label
    this.color = color
  }

  press(): void {
    this.host?.changePage(this.delta)
  }

  mount(host: TileHost): void {
    this.host = host
  }

  unmount(): void {
    this.host = null
  }

  draw(surface: Surface): void {
    const forward = this.delta >= 0
    drawBackground(surface, this.color)
    icon(surface, forward ? 'next' : 'previous', {
      x: surface.width / 2,
      y: FACE_CENTER,
      size: 52,
      color: '#eceff1',
    })
    // Only a mounted tile can name its target; before that the caption is the
    // configured fallback rather than a page name that might be wrong.
    const target = this.host?.pageName(this.delta)
    drawCaption(surface, target ?? this.label)
  }
}
