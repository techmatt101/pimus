// A key that starts one of a short list of playlists. Press it once and it does
// not play anything yet: it claims the shared dial and lights up, so the next
// turn of the dynamic dial steps through the list and the strip shows the one
// you have landed on. Press again — the key or the knob — to confirm and play
// it. A single playlist is just a list of one: press, then press to confirm.
//
// The pick-and-confirm itself is the reusable SelectionDial
// (streamdeck/dials/selection-dial.mts); the glow and the fifteen-second timeout
// are the shared dial's (streamdeck/dials/dynamic-dial.mts). This key only says
// what a choice is (a media id for its player) and what confirming does.
//
// While that player is playing, the key also lights up — it cannot tell whether
// one of these playlists is the thing playing (Home Assistant does not report
// the queue source consistently across integrations), so it reports the player's
// own state and nothing more precise than that.

import {requireEntity} from '../../actions/catalog.mjs'
import {createBindings, type TileServices} from '../bindings.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {SelectionDial, type SelectionOption} from '../dials/selection-dial.mjs'
import {drawActiveGlow, drawDots, drawLabelFace, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import {icon, type Surface} from '../surface.mjs'
import type {HomeAssistantService} from '../../types.mjs'

/** One entry in the key's list: a label to show and what to play. */
export interface PlaylistChoice extends SelectionOption {
    /** Service data for `media_player.play_media`. */
    media: {
        media_content_id: string
        media_content_type: string
        [option: string]: unknown
    }
}

export interface PlaylistTileConfig {
    label: string
    /** The media player entity the chosen playlist is sent to. */
    player: string
    /** The playlists this key chooses between; one is allowed. */
    playlists: readonly PlaylistChoice[]
    /** The shared dial this key claims to choose a playlist while active. */
    dial: DynamicDial
    /** Background while active or while the player is playing. */
    color?: string
}

/** The dots sit between the note glyph and the caption bar. */
const DOTS_Y = 80

export class PlaylistTile implements Tile {
    private readonly ha: HomeAssistantService
    private readonly config: PlaylistTileConfig
    private readonly player: string
    private readonly dial: DynamicDial
    private readonly selection: SelectionDial<PlaylistChoice>
    private readonly bindings: ReturnType<typeof createBindings>
    private unwatch: (() => void) | null = null

    constructor(services: TileServices, config: PlaylistTileConfig) {
        this.ha = services.ha
        this.config = config
        this.player = requireEntity(config.player, `${config.label} playlist tile`)
        this.dial = config.dial
        this.bindings = createBindings(services)
        this.selection = new SelectionDial(config.label, config.playlists, {
            onConfirm: () => this.confirm(),
            // A turn moves the pick with no device call, so nothing else repaints
            // the face and the dot: mutate, then notify like everywhere else.
            onChange: () => services.model.notify(),
        })
    }

    press(): unknown {
        // Already listening: this press is the confirm. Otherwise it arms the dial
        // and lights the key, and it is the next press that plays.
        if (this.dial.holds(this.selection)) return this.confirm()
        // A transient claim: it glows, times out after 15s, and lets go the moment
        // another dial is turned — a "pick one now", not the sticky hold a light gets.
        this.dial.claim(this.selection, true)
        return undefined
    }

    /** Play the choice now showing and hand the dial back. */
    private confirm(): unknown {
        const choice = this.selection.selected
        this.dial.release()
        if (!choice) return undefined
        return this.bindings.ha('play_media', this.player, {...choice.media}).run()
    }

    mount(host: TileHost): void {
        this.unwatch = this.ha.watch([this.player], () => host.invalidate())
    }

    unmount(): void {
        this.unwatch?.()
        this.unwatch = null
        // Paging away hides the key, so it must not leave the shared dial pointed
        // at a playlist picker the user can no longer see.
        if (this.dial.holds(this.selection)) this.dial.release()
    }

    draw(surface: Surface): void {
        const active = this.dial.holds(this.selection)
        const playing = this.ha.entity(this.player)?.state === 'playing'
        const lit = active || playing
        const color = this.config.color ?? '#00695c'

        // While active the caption is the pick you are about to confirm; otherwise
        // it is the key's own name.
        drawLabelFace(surface, lit ? color : '#0d2622', active ? this.selection.detail() : this.config.label)
        icon(surface, 'note', {
            x: surface.width / 2,
            y: FACE_CENTER,
            size: 54,
            color: lit ? '#ffffff' : '#4db6ac',
        })

        // A dot per playlist with the pick filled, so a glance says how many there
        // are and where you are in them — pointless for a list of one.
        if (this.config.playlists.length > 1) {
            drawDots(surface, this.config.playlists.length, this.selection.index, DOTS_Y, active ? '#ffffff' : '#4db6ac')
        }

        if (active) drawActiveGlow(surface)
    }
}
