// The strip's resting face while a track is playing or paused: what is playing,
// across the full width. The touch strip shows it whenever no dial is being
// turned and no notification is up and the player has a track; when the player
// is stopped the strip shows IdleScreen (the clock) instead, which is why
// `applies()` below reports whether there is a track to show.
//
// The reading comes from the Music Assistant player entity rather than from the
// controller's own `media` flag, because that flag is only "is something
// playing" — the title, the artist, and the position exist solely in Home
// Assistant. The screen watches that one entity while mounted, exactly as a tile
// does, so the strip keeps working on pages where no key happens to watch the
// player.
//
// The resting face is not only a readout: its left edge carries a play/pause and
// a shuffle button, so the transport lives on the strip rather than needing its
// own keys. Those are the two controls that used to be a dedicated key; the
// buttons both set and reflect their state, drawn from the same player entity the
// rest of the face reads. Tapping the strip over one runs it (streamdeck/strip.mts
// hands the resting screen the tap first); a tap that misses them falls through to
// the dial in that zone. The right edge, where those buttons used to sit, carries
// a clock, so a glance at the strip always tells the time.

import {requireEntity} from '../../actions/catalog.mjs'
import {type Binding, haBinding, voiceBinding} from '../bindings.mjs'
import {mediaElapsedSeconds, numericAttribute} from '../../home-assistant/entity.mjs'
import {drawIcon, drawText, fittingSize, REGULAR, type Surface, verticalGradient} from '../surface.mjs'
import {
    clockTime,
    drawStripBar,
    drawStripLine,
    minuteTick,
    overflows,
    type Screen,
    type ScreenHost,
    SCROLL_FRAME_MILLISECONDS,
    STRIP_WIDTH,
} from './screen.mjs'
import type {IconName} from '../icon-set.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantEntity, HomeAssistantService, LvaSender} from '../../types.mjs'

/** Title sizes tried in turn, so a short title is drawn large. */
const TITLE_SIZES = [56, 46, 36]
const SECONDARY_SIZE = 24
/** How often the position bar creeps forward while a track plays. */
const POSITION_FRAME_MILLISECONDS = 1000

// The two transport buttons occupy the left edge now — play/pause then shuffle —
// so the controls sit under the thumb; each is a full-height tap zone so the
// target is easy to hit blind.
const BUTTON_ICON = 44
const BUTTON_Y = 44
const BUTTON_ZONE = 96
const PLAY_ZONE_RIGHT = BUTTON_ZONE
const SHUFFLE_ZONE_RIGHT = BUTTON_ZONE * 2
const PLAY_CENTER = BUTTON_ZONE / 2
const SHUFFLE_CENTER = BUTTON_ZONE + BUTTON_ZONE / 2

// The clock takes the right edge, where the buttons used to be, so a glance at
// the strip always carries the time.
const CLOCK_SIZE = 40
const CLOCK_WIDTH = 132
const CLOCK_LEFT = STRIP_WIDTH - CLOCK_WIDTH
const CLOCK_CENTER = CLOCK_LEFT + CLOCK_WIDTH / 2

/** The text region is everything between the buttons and the clock: the width a
 * title has to fit before it starts scrolling. */
const TEXT_LEFT = SHUFFLE_ZONE_RIGHT + 16
const TEXT_AVAILABLE = CLOCK_LEFT - 16 - TEXT_LEFT

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
/** Play/pause glyph: lit while playing, muted while paused. */
const PLAY_ON = '#26c6da'
const PLAY_OFF = '#78909c'
/** Shuffle glyph: lit when shuffling, dim when the queue plays straight. */
const SHUFFLE_ON = '#80deea'
const SHUFFLE_OFF = '#37474f'
/** The strip's own clock at the right edge, muted so the track stays the loud thing. */
const CLOCK_COLOR = '#90a4ae'

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

    constructor(ha: HomeAssistantService, clock: () => number, lva: LvaSender, model: ControlModel, {player}: NowPlayingOptions) {
        this.#ha = ha
        this.#clock = clock
        this.#player = requireEntity(player, 'now playing screen')
        // Play/pause goes through LVA exactly as the media dial's press does, so the
        // strip button and the knob toggle the same playback; shuffle lives on the
        // Music Assistant player, which is the only place a queue exists.
        this.#playPause = voiceBinding(lva, model, 'media_toggle')
        this.#shuffle = haBinding(ha, 'media_shuffle', this.#player)
    }

    mount(host: ScreenHost): void {
        this.#host = host
        this.#unwatch = this.#ha.watch([this.#player], () => host.invalidate())
    }

    /**
     * Whether there is a track to show: the strip shows this face while the player
     * is playing or paused, and the idle clock (IdleScreen) once it is stopped.
     * Paused keeps its track, so it stays here; a stopped player drops its title,
     * so it falls through to the clock.
     */
    applies(): boolean {
        return !nowPlayingLines(this.#ha.entity(this.#player), this.#ha.connected).idle
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
        const {title} = nowPlayingLines(player, this.#ha.connected)
        if (overflows(title, fittingSize(title, TITLE_SIZES, TEXT_AVAILABLE), TEXT_AVAILABLE)) {
            return SCROLL_FRAME_MILLISECONDS
        }
        // The right-edge clock must repaint at least on the minute boundary for its
        // digits to change; a playing track already repaints faster for its position
        // bar. Re-computing the boundary each paint re-arms the strip's frame timer
        // on the minute rather than drifting a fixed minute off it.
        const playing = player?.state === 'playing'
        return playing && hasPosition(player) ? POSITION_FRAME_MILLISECONDS : minuteTick(this.#clock())
    }

    /**
     * The left edge carries the two buttons; a tap over one runs it, and a tap
     * anywhere else is left for the dial beneath. This face only shows while there
     * is a track (`applies`), so there is always something to play or shuffle. A
     * hit also lights the button's press flash, which is the closest the LCD lets
     * us get to showing a finger on it — the hardware only reports the tap once
     * the finger lifts.
     */
    pressAt(x: number): (() => unknown) | undefined {
        if (x < PLAY_ZONE_RIGHT) return this.#press('play', this.#playPause)
        if (x < SHUFFLE_ZONE_RIGHT) return this.#press('shuffle', this.#shuffle)
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
        const {title, secondary} = nowPlayingLines(player, this.#ha.connected)
        surface.fill(verticalGradient(surface, BACKDROP[0], BACKDROP[1]))

        const playing = player?.state === 'playing'
        // Title and credit both left-aligned and bounded to the text region, so
        // they sit under a steady left edge and only ever scroll between the
        // buttons and the clock, never over either.
        drawStripLine(surface, title, {
            centerY: secondary ? 36 : 46,
            size: fittingSize(title, TITLE_SIZES, TEXT_AVAILABLE),
            color: playing ? PLAYING_TITLE : PAUSED_TITLE,
            left: TEXT_LEFT,
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
                left: TEXT_LEFT,
                width: TEXT_AVAILABLE,
                now,
            })
        }

        this.#drawButtons(surface, playing, Boolean(player?.attributes.shuffle))
        drawText(surface, clockTime(now), {x: CLOCK_CENTER, y: BUTTON_Y, size: CLOCK_SIZE, color: CLOCK_COLOR})

        // A position bar only where the player reports one; Music Assistant does for
        // a track and does not for a live stream.
        const duration = numericAttribute(player, 'media_duration')
        const elapsed = mediaElapsedSeconds(player, now)
        if (hasPosition(player) && duration && elapsed !== undefined) {
            drawStripBar(surface, elapsed / duration, {color: playing ? '#26c6da' : '#37474f'})
        }
    }

    /** The play/pause and shuffle glyphs at the left edge, each lit by its state. */
    #drawButtons(surface: Surface, playing: boolean, shuffled: boolean): void {
        const flash = this.#flash()
        const play = {icon: (playing ? 'pause' : 'play') as IconName, color: playing ? PLAY_ON : PLAY_OFF}
        this.#drawButton(surface, 0, PLAY_CENTER, play.icon, play.color, this.#pressed === 'play' ? flash : 0)
        this.#drawButton(surface, BUTTON_ZONE, SHUFFLE_CENTER, 'shuffle', shuffled ? SHUFFLE_ON : SHUFFLE_OFF, this.#pressed === 'shuffle' ? flash : 0)
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
            ctx.roundRect(zoneLeft + 10, BUTTON_Y - 34, BUTTON_ZONE - 20, 68, 14)
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
