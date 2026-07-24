import {type Surface, withAlpha} from '../surface.mjs'
import {drawBackground, drawCaption, type Tile} from '../tile.mjs'
import type {RemoteTileFeed} from '../../types.mjs'

export interface RemoteTileConfig {
    /** Which REMOTE-page slot this key shows, 0 to 5 in reading order. */
    slot: number
}

/**
 * A key drawn from whatever face a client last pushed over the remote-tile
 * socket. The tile holds nothing: the server owns the faces, and pressing
 * reports straight back to the client that owns the slot.
 */
export class RemoteTile implements Tile {
    readonly #remote: RemoteTileFeed
    readonly #slot: number

    constructor(remote: RemoteTileFeed, {slot}: RemoteTileConfig) {
        this.#remote = remote
        this.#slot = slot
    }

    press(): void {
        this.#remote.press(this.#slot)
    }

    draw(surface: Surface): void {
        const face = this.#remote.tile(this.#slot)
        if (!face) {
            drawBackground(surface, '#0a0d10')
            surface.ctx.fillStyle = withAlpha('#607d8b', 0.35)
            surface.ctx.beginPath()
            surface.ctx.arc(surface.width / 2, surface.height / 2, 4, 0, 2 * Math.PI)
            surface.ctx.fill()
            return
        }
        drawBackground(surface, face.color)
        if (face.image) surface.ctx.drawImage(face.image, 0, 0, surface.width, surface.height)
        if (face.label) drawCaption(surface, face.label)
    }
}
