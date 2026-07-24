// A key that starts one of a short list of playlists. Press it once and it does
// not play anything yet: it claims the shared dial and lights up, so the next
// turn of the dynamic dial steps through the list and the strip shows the one
// you have landed on. Press again — the key or the knob — to confirm and play
// it. A single playlist is just a list of one: press, then press to confirm.
//
// The pick-and-confirm itself is the reusable SelectionDial
// (streamdeck/selection-dial.mts); the glow and the fifteen-second timeout
// are the shared dial's (streamdeck/dials/dynamic-dial.mts). This key only says
// what a choice is (a media id for its player) and what confirming does, so it
// takes only the Home Assistant service — not the whole tile-services bag.
//
// It listens to the player and lights the playlist that is playing: when the
// player reports a `media_content_id` matching one of these, that entry is drawn
// lit even when the key is idle, so a glance says which of them is on. A player
// that does not report the id back simply lights nothing, rather than the key
// guessing from bare playback that any of its playlists is the one running.

import {requireEntity} from '../../actions/catalog.mjs'
import {haBinding} from '../bindings.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {SelectionDial, type SelectionOption} from '../selection-dial.mjs'
import {drawActiveGlow, drawDots, drawLabelFace, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import {drawIcon, type Surface} from '../surface.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

/** One entry in the key's list: a label to show and what to play. */
export interface PlaylistChoice extends SelectionOption {
    /** Service data for `media_player.play_media`. */
    media: {
        media_content_id: string
        media_content_type: string
        [option: string]: unknown
    }
}

/** The key's heading, shown on the strip while picking and as its resting caption. */
const TITLE = 'MUSIC'
/** Background while active or while one of these playlists is playing. */
const COLOR = '#00695c'
/** The dots sit between the note glyph and the caption bar. */
const DOTS_Y = 80

export class PlaylistTile implements Tile {
    readonly #ha: HomeAssistantService
    readonly #dial: DynamicDial
    readonly #player: string
    readonly #playlists: readonly PlaylistChoice[]
    readonly #selection: SelectionDial<PlaylistChoice>
    #host: TileHost | null = null
    #unwatch: (() => void) | null = null

    constructor(
        ha: HomeAssistantService,
        dial: DynamicDial,
        player: string,
        playlists: readonly PlaylistChoice[],
    ) {
        this.#ha = ha
        this.#dial = dial
        this.#player = requireEntity(player, `${TITLE} playlist tile`)
        this.#playlists = playlists
        this.#selection = new SelectionDial(TITLE, playlists, {
            onConfirm: () => this.#confirm(),
            // A turn moves the pick with no device call, so only this key's own face
            // (its caption and dot) is stale; the strip repaints on the turn itself.
            onChange: () => this.#host?.invalidate(),
        })
    }

    press(): void {
        // Already listening: this press is the confirm. Otherwise it arms the dial
        // and lights the key, and it is the next press that plays.
        if (this.#dial.holds(this.#selection)) return this.#confirm()
        // A transient claim: it glows, times out after 15s, and lets go the moment
        // another dial is turned — a "pick one now", not the sticky hold a light gets.
        this.#dial.claim(this.#selection, true)
    }

    /** Play the choice now showing and hand the dial back. */
    #confirm(): void {
        const choice = this.#selection.selected
        this.#dial.release()
        if (!choice) return undefined
        haBinding(this.#ha, 'play_media', this.#player, {...choice.media}).run()
    }

    mount(host: TileHost): void {
        this.#host = host
        this.#unwatch = this.#ha.watch([this.#player], () => host.invalidate())
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
        this.#host = null
        // Paging away hides the key, so it must not leave the shared dial pointed
        // at a playlist picker the user can no longer see.
        if (this.#dial.holds(this.#selection)) this.#dial.release()
    }

    draw(surface: Surface): void {
        const active = this.#dial.holds(this.#selection)
        const playing = this.#playingIndex()
        const lit = active || playing >= 0
        // The face points at the pick while choosing, otherwise at the playlist that
        // is playing, and rests on its own name when neither applies.
        const shown = active ? this.#selection.index : playing
        const label = active ? this.#selection.detail() : this.#playlists[shown]?.label ?? TITLE

        drawLabelFace(surface, lit ? COLOR : '#0d2622', label)
        drawIcon(surface, 'note', {
            x: surface.width / 2,
            y: FACE_CENTER,
            size: 54,
            color: lit ? '#ffffff' : '#4db6ac',
        })

        // A dot per playlist with the shown one filled, so a glance says how many
        // there are and where you are in them — pointless for a list of one.
        if (this.#playlists.length > 1) {
            drawDots(surface, this.#playlists.length, Math.max(0, shown), DOTS_Y, lit ? '#ffffff' : '#4db6ac')
        }

        if (active) drawActiveGlow(surface)
    }

    /**
     * Which of this key's playlists the player is currently playing, or -1. Best
     * effort: it matches the player's reported `media_content_id` against the ids
     * this key sends, so it only lights up when the integration reports the source
     * back.
     */
    #playingIndex(): number {
        const player: HomeAssistantEntity | undefined = this.#ha.entity(this.#player)
        if (player?.state !== 'playing') return -1
        const current = player.attributes['media_content_id']
        if (typeof current !== 'string') return -1
        return this.#playlists.findIndex((choice) => choice.media.media_content_id === current)
    }
}
