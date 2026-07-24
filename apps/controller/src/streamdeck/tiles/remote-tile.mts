// A key on the REMOTE page, drawn from whatever face a client last pushed over
// the remote-tile socket (remote/server.mts). The tile itself holds nothing:
// the server owns the faces and notifies the model when one changes, so a
// repaint reads the current face the same way every other tile reads live
// state. Pressing the key reports straight back to the client that owns it.

import {type Surface, withAlpha} from '../surface.mjs'
import type {TileServices} from '../bindings.mjs'
import {drawBackground, drawCaption, type Tile} from '../tile.mjs'

export interface RemoteTileConfig {
    /** Which REMOTE-page slot this key shows, 0 to 5 in reading order. */
    slot: number
}

export class RemoteTile implements Tile {
    private readonly services: TileServices
    private readonly slot: number

    constructor(services: TileServices, {slot}: RemoteTileConfig) {
        this.services = services
        this.slot = slot
    }

    press(): void {
        this.services.remote?.press(this.slot)
    }

    draw(surface: Surface): void {
        const face = this.services.remote?.tile(this.slot)
        if (!face) {
            // An empty socket: dark, with a faint marker so the page reads as six
            // places a client can fill rather than as a dead key.
            drawBackground(surface, '#0a0d10')
            surface.ctx.fillStyle = withAlpha('#607d8b', 0.35)
            surface.ctx.beginPath()
            surface.ctx.arc(surface.width / 2, surface.height / 2, 4, 0, 2 * Math.PI)
            surface.ctx.fill()
            return
        }
        drawBackground(surface, face.color)
        // The image fills the key; the caption bar sits over its foot, exactly as
        // it does on every other face, so a pushed key still looks like this deck.
        if (face.image) surface.ctx.drawImage(face.image, 0, 0, surface.width, surface.height)
        if (face.label) drawCaption(surface, face.label)
    }
}
