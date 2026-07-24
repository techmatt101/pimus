// A one-press shortcut to a specific playlist. The media id is compiled into
// the layout alongside the player it goes to, so the key is a bookmark rather
// than anything the user has to navigate to.
//
// While that player is playing, the key lights up — it cannot tell whether this
// particular playlist is the thing playing (Home Assistant does not report the
// queue source consistently across integrations), so it reports the player's
// own state and nothing more precise than that.

import {requireEntity} from '../../actions/catalog.mjs'
import {type Binding, createBindings, type TileServices} from '../bindings.mjs'
import {drawLabelFace, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import {icon, type Surface} from '../surface.mjs'
import type {Action, HomeAssistantService} from '../../types.mjs'

export interface PlaylistTileConfig {
    label: string
    /** The media player entity the playlist is sent to. */
    player: string
    /** Service data for `media_player.play_media`. */
    media: {
        media_content_id: string
        media_content_type: string
        [option: string]: unknown
    }
    color?: string
}

export class PlaylistTile implements Tile {
    private readonly ha: HomeAssistantService
    private readonly config: PlaylistTileConfig
    private readonly player: string
    private readonly play: Binding
    private unwatch: (() => void) | null = null

    constructor(services: TileServices, config: PlaylistTileConfig) {
        this.ha = services.ha
        this.config = config
        this.player = requireEntity(config.player, `${config.label} playlist tile`)
        this.play = createBindings(services).ha('play_media', this.player, {...config.media})
    }

    action(): Action {
        return this.play.action
    }

    press(): unknown {
        return this.play.run()
    }

    mount(host: TileHost): void {
        this.unwatch = this.ha.watch([this.player], () => host.invalidate())
    }

    unmount(): void {
        this.unwatch?.()
        this.unwatch = null
    }

    draw(surface: Surface): void {
        const playing = this.ha.entity(this.player)?.state === 'playing'
        drawLabelFace(surface, playing ? this.config.color ?? '#00695c' : '#0d2622', this.config.label)
        icon(surface, 'note', {
            x: surface.width / 2,
            y: FACE_CENTER,
            size: 54,
            color: playing ? '#ffffff' : '#4db6ac',
        })
    }
}
