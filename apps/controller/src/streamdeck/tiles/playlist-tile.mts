import {requireEntity} from '../../actions/catalog.mjs'
import {ArmedControl} from '../armed-control.mjs'
import {haBinding} from '../bindings.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {SelectionDial, type SelectionOption} from '../selection-dial.mjs'
import {drawActiveGlow, drawDots, drawLabelFace, FACE_CENTER, type Tile, type TileHost} from '../tile.mjs'
import {drawIcon, type Surface} from '../surface.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

export interface PlaylistTileConfig {
    player: string,
    playlists: readonly PlaylistChoice[],
}

export interface PlaylistChoice extends SelectionOption {
    /** Service data for `media_player.play_media`. */
    media: {
        media_content_id: string
        media_content_type: string
        [option: string]: unknown
    }
}

const TITLE = 'MUSIC'
const COLOR = '#00695c'
const DOTS_Y = 80

/**
 * Press to arm: the shared dial steps through the playlists. Press again — the
 * key or the knob — to confirm and play.
 */
export class PlaylistTile implements Tile {
    readonly #ha: HomeAssistantService
    readonly #dial: DynamicDial
    readonly #player: string
    readonly #playlists: readonly PlaylistChoice[]
    readonly #selection: SelectionDial<PlaylistChoice>
    readonly #armed: ArmedControl
    #host: TileHost | null = null
    #unwatch: (() => void) | null = null

    constructor(
        ha: HomeAssistantService,
        dial: DynamicDial,
        config: PlaylistTileConfig,
    ) {
        this.#ha = ha
        this.#dial = dial
        this.#player = requireEntity(config.player, `${TITLE} playlist tile`)
        this.#playlists = config.playlists
        this.#selection = new SelectionDial(TITLE, config.playlists, {
            onConfirm: () => this.#confirm(),
            onChange: () => this.#host?.invalidate(),
        })
        this.#armed = new ArmedControl(dial, this.#selection, () => this.#confirm())
    }

    press(): void {
        this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

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
        // Paging away must not leave the shared dial pointed at a picker the
        // user can no longer see.
        this.#armed.release()
    }

    draw(surface: Surface): void {
        const active = this.#armed.armed
        const playing = this.#playingIndex()
        const lit = active || playing >= 0
        const shown = active ? this.#selection.index : playing
        const label = active ? this.#selection.detail() : this.#playlists[shown]?.label ?? TITLE

        drawLabelFace(surface, lit ? COLOR : '#0d2622', label)
        drawIcon(surface, 'note', {
            x: surface.width / 2,
            y: FACE_CENTER,
            size: 54,
            color: lit ? '#ffffff' : '#4db6ac',
        })

        if (this.#playlists.length > 1) {
            drawDots(surface, this.#playlists.length, Math.max(0, shown), DOTS_Y, lit ? '#ffffff' : '#4db6ac')
        }

        if (active) drawActiveGlow(surface)
    }

    // Best effort: only lights up when the integration reports the
    // media_content_id back, rather than guessing from bare playback.
    #playingIndex(): number {
        const player: HomeAssistantEntity | undefined = this.#ha.entity(this.#player)
        if (player?.state !== 'playing') return -1
        const current = player.attributes['media_content_id']
        if (typeof current !== 'string') return -1
        return this.#playlists.findIndex((choice) => choice.media.media_content_id === current)
    }
}
