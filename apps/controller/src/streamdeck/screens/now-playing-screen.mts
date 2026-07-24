// The strip's resting face: what is playing, across the full width. This is
// what the touch strip shows whenever no dial is being turned and no
// notification is up.
//
// The reading comes from the Music Assistant player entity rather than from the
// controller's own `media` flag, because that flag is only "is something
// playing" — the title, the artist, and the position exist solely in Home
// Assistant. The screen watches that one entity while mounted, exactly as a tile
// does, so the strip keeps working on pages where no key happens to watch the
// player.
//
// The resting face is not only a readout: its right edge carries a play/pause
// and a shuffle button, so the transport lives where the track is named rather
// than needing its own keys. Those are the two controls that used to be a
// dedicated key; the buttons both set and reflect their state, drawn from the
// same player entity the rest of the face reads. Tapping the strip over one runs
// it (streamdeck/strip.mts hands the resting screen the tap first); a tap that
// misses them falls through to the dial in that zone.

import {requireEntity} from '../../actions/catalog.mjs'
import {type Binding, createBindings, type TileServices} from '../bindings.mjs'
import {mediaElapsedSeconds, numericAttribute} from '../../home-assistant/entity.mjs'
import {drawIcon, fittingSize, REGULAR, type Surface, verticalGradient} from '../surface.mjs'
import {
    drawStripBar,
    drawStripLine,
    overflows,
    type Screen,
    type ScreenHost,
    SCROLL_FRAME_MILLISECONDS,
    STRIP_MARGIN,
    STRIP_WIDTH,
} from './screen.mjs'
import type {IconName} from '../icon-set.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

/** Title sizes tried in turn, so a short title is drawn large. */
const TITLE_SIZES = [56, 46, 36]
const SECONDARY_SIZE = 24
/** How often the position bar creeps forward while a track plays. */
const POSITION_FRAME_MILLISECONDS = 1000

// The two transport buttons occupy the right edge; each is a full-height tap
// zone so the target is easy to hit blind. The text region is everything to
// their left, which is the width a title has to fit before it starts scrolling.
const BUTTON_ICON = 44
const BUTTON_Y = 44
const PLAY_ZONE_LEFT = STRIP_WIDTH - 96
const SHUFFLE_ZONE_LEFT = PLAY_ZONE_LEFT - 96
const PLAY_CENTER = (PLAY_ZONE_LEFT + STRIP_WIDTH) / 2
const SHUFFLE_CENTER = (SHUFFLE_ZONE_LEFT + PLAY_ZONE_LEFT) / 2
/** Text stops short of the buttons, with a little breathing room before them. */
const TEXT_AVAILABLE = SHUFFLE_ZONE_LEFT - 16 - STRIP_MARGIN

// The strip's LCD only reports a tap once the finger lifts (there is no
// finger-down event for it), so a held "pressing" state is not something the
// hardware can tell us. This is the next best thing: the button that was tapped
// glows for a moment and fades, so a press is acknowledged rather than only its
// result. The flash is derived from the clock so drawing stays a pure function
// of it, exactly as the scroll and position bar are.
const FLASH_MILLISECONDS = 200
const FLASH_FRAME_MILLISECONDS = 30
const FLASH_PEAK = 0.24
const PRESSED_ICON = '#ffffff'
type Button = 'play' | 'shuffle'

/** The resting strip is washed rather than flat, like the key faces. */
const BACKDROP = ['#16222b', '#0b1116'] as const

const PLAYING_TITLE = '#ffffff'
const PAUSED_TITLE = '#78909c'
const SECONDARY = '#80deea'
const IDLE = '#546e7a'
/** Play/pause glyph: lit while playing, muted while paused. */
const PLAY_ON = '#26c6da'
const PLAY_OFF = '#78909c'
/** Shuffle glyph: lit when shuffling, dim when the queue plays straight. */
const SHUFFLE_ON = '#80deea'
const SHUFFLE_OFF = '#37474f'

export interface NowPlayingOptions {
    /** The `media_player.` entity whose track the strip reports. */
    player: string
}

/**
 * The two lines the strip shows for a player: what is playing, and who by.
 * Derived separately from the drawing so the wording is testable and so the
 * three cases the strip must tell apart — playing something, playing nothing,
 * and not knowing — stay explicit. `idle` is also what gates the transport
 * buttons: there is nothing to pause or shuffle without a track.
 */
export function nowPlayingLines(
    player: HomeAssistantEntity | undefined,
    connected: boolean,
): { title: string; secondary: string; idle: boolean } {
    // An unreachable Home Assistant must not read as a quiet room, the same rule
    // the Home Assistant keys follow.
    if (!connected || !player) return {title: 'NO MEDIA INFO', secondary: '', idle: true}

    const title = text(player.attributes.media_title)
    if (!title) return {title: 'NOTHING PLAYING', secondary: '', idle: true}

    const artist = text(player.attributes.media_artist) || text(player.attributes.media_album_artist)
    const album = text(player.attributes.media_album_name)
    // Paused is carried by the dimmed title and the play glyph, not by a word.
    return {title, secondary: [artist, album].filter(Boolean).join(' - '), idle: false}
}

export class NowPlayingScreen implements Screen {
    readonly #ha: HomeAssistantService
    readonly #clock: () => number
    readonly #player: string
    readonly #playPause: Binding
    readonly #shuffle: Binding
    #host: ScreenHost | null = null
    #unwatch: (() => void) | null = null
    // Which button was last tapped and when, so its press flash can be drawn and
    // faded from the clock. Held as an instant, not a countdown, for the same
    // reason the dial hold and scroll offset are.
    #pressed: Button | null = null
    #pressedAt = 0

    constructor(services: TileServices, {player}: NowPlayingOptions) {
        this.#ha = services.ha
        this.#clock = services.clock
        this.#player = requireEntity(player, 'now playing screen')
        const {voice, ha} = createBindings(services)
        // Play/pause goes through LVA exactly as the media dial's press does, so the
        // strip button and the knob toggle the same playback; shuffle lives on the
        // Music Assistant player, which is the only place a queue exists.
        this.#playPause = voice('media_toggle')
        this.#shuffle = ha('media_shuffle', this.#player)
    }

    mount(host: ScreenHost): void {
        this.#host = host
        this.#unwatch = this.#ha.watch([this.#player], () => host.invalidate())
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
        this.#host = null
    }

    /**
     * Frames for a title too long to sit still, and a slow tick while a track is
     * playing so its position bar creeps forward. Music Assistant reports a
     * position once and then says nothing, so without the tick the bar would only
     * move when something unrelated repainted the deck.
     */
    animationMilliseconds(): number | undefined {
        // A fading press flash wins: it is the fastest thing on the face and only
        // runs for its brief window.
        if (this.#flashing()) return FLASH_FRAME_MILLISECONDS
        const player = this.#ha.entity(this.#player)
        const {title, idle} = nowPlayingLines(player, this.#ha.connected)
        if (idle) return undefined
        if (overflows(title, fittingSize(title, TITLE_SIZES, TEXT_AVAILABLE), TEXT_AVAILABLE)) {
            return SCROLL_FRAME_MILLISECONDS
        }
        const playing = player?.state === 'playing'
        return playing && hasPosition(player) ? POSITION_FRAME_MILLISECONDS : undefined
    }

    /**
     * The right edge carries the two buttons; a tap over one runs it, and a tap
     * anywhere else is left for the dial beneath. There is nothing to run while
     * the strip is idle, so those taps fall through too. A hit also lights the
     * button's press flash, which is the closest the LCD lets us get to showing a
     * finger on it — the hardware only reports the tap once the finger lifts.
     */
    pressAt(x: number): (() => unknown) | undefined {
        const {idle} = nowPlayingLines(this.#ha.entity(this.#player), this.#ha.connected)
        if (idle) return undefined
        if (x >= PLAY_ZONE_LEFT) return this.#press('play', this.#playPause)
        if (x >= SHUFFLE_ZONE_LEFT) return this.#press('shuffle', this.#shuffle)
        return undefined
    }

    /** Light the button's flash now, and hand back the thunk that runs it. */
    #press(button: Button, binding: Binding): () => unknown {
        this.#pressed = button
        this.#pressedAt = this.#clock()
        this.#host?.invalidate()
        return () => binding.run()
    }

    /** How lit the press flash is (1..0), or 0 once it has faded. */
    #flash(): number {
        const elapsed = this.#clock() - this.#pressedAt
        if (this.#pressed === null || elapsed >= FLASH_MILLISECONDS) return 0
        return 1 - elapsed / FLASH_MILLISECONDS
    }

    #flashing(): boolean {
        return this.#flash() > 0
    }

    draw(surface: Surface): void {
        const now = this.#clock()
        const player = this.#ha.entity(this.#player)
        const {title, secondary, idle} = nowPlayingLines(player, this.#ha.connected)
        surface.fill(verticalGradient(surface, BACKDROP[0], BACKDROP[1]))

        if (idle) {
            drawStripLine(surface, title, {centerY: 50, size: 34, color: IDLE, now})
            return
        }

        const playing = player?.state === 'playing'
        // Title and credit both left-aligned and bounded to the text region, so
        // they sit under a steady left edge and only ever scroll past the buttons,
        // never over them.
        drawStripLine(surface, title, {
            centerY: secondary ? 36 : 46,
            size: fittingSize(title, TITLE_SIZES, TEXT_AVAILABLE),
            color: playing ? PLAYING_TITLE : PAUSED_TITLE,
            left: STRIP_MARGIN,
            width: TEXT_AVAILABLE,
            now,
        })
        if (secondary) {
            // Lighter than the title, so the strip reads as one line with a credit
            // under it rather than as two competing lines.
            drawStripLine(surface, secondary, {
                centerY: 74,
                size: SECONDARY_SIZE,
                color: SECONDARY,
                weight: REGULAR,
                left: STRIP_MARGIN,
                width: TEXT_AVAILABLE,
                now,
            })
        }

        this.#drawButtons(surface, playing, Boolean(player?.attributes.shuffle))

        // A position bar only where the player reports one; Music Assistant does for
        // a track and does not for a live stream.
        const duration = numericAttribute(player, 'media_duration')
        const elapsed = mediaElapsedSeconds(player, now)
        if (hasPosition(player) && duration && elapsed !== undefined) {
            drawStripBar(surface, elapsed / duration, {color: playing ? '#26c6da' : '#37474f'})
        }
    }

    /** The play/pause and shuffle glyphs at the right edge, each lit by its state. */
    #drawButtons(surface: Surface, playing: boolean, shuffled: boolean): void {
        const flash = this.#flash()
        const play = {icon: (playing ? 'pause' : 'play') as IconName, color: playing ? PLAY_ON : PLAY_OFF}
        this.#drawButton(surface, PLAY_ZONE_LEFT, PLAY_CENTER, play.icon, play.color, this.#pressed === 'play' ? flash : 0)
        this.#drawButton(surface, SHUFFLE_ZONE_LEFT, SHUFFLE_CENTER, 'shuffle', shuffled ? SHUFFLE_ON : SHUFFLE_OFF, this.#pressed === 'shuffle' ? flash : 0)
    }

    /**
     * One transport glyph, over a rounded highlight while its press flash is
     * fading. The glyph goes full white at the peak of the flash, so a tap reads
     * even where the button's resting colour is already bright.
     */
    #drawButton(surface: Surface, zoneLeft: number, center: number, icon: IconName, color: string, flash: number): void {
        if (flash > 0) {
            const {ctx} = surface
            ctx.save()
            ctx.globalAlpha = flash * FLASH_PEAK
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.roundRect(zoneLeft + 10, BUTTON_Y - 34, PLAY_ZONE_LEFT - SHUFFLE_ZONE_LEFT - 20, 68, 14)
            ctx.fill()
            ctx.restore()
        }
        drawIcon(surface, icon, {x: center, y: BUTTON_Y, size: BUTTON_ICON, color: flash > 0 ? PRESSED_ICON : color})
    }
}

/** Whether the player reports both a length and a position, so a bar means something. */
function hasPosition(player: HomeAssistantEntity | undefined): boolean {
    const duration = numericAttribute(player, 'media_duration')
    return duration !== undefined && duration > 0 && numericAttribute(player, 'media_position') !== undefined
}

/** A trimmed string attribute, or '' for anything Home Assistant left unset. */
function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}
