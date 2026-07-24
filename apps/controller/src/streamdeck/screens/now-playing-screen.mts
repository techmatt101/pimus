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

const TITLE_SIZES = [56, 46, 36]
const SECONDARY_SIZE = 24
const POSITION_FRAME_MILLISECONDS = 1000

const BUTTON_ICON = 44
const BUTTON_Y = 44
const BUTTON_ZONE = 96
const PLAY_ZONE_RIGHT = BUTTON_ZONE
const SHUFFLE_ZONE_RIGHT = BUTTON_ZONE * 2
const PLAY_CENTER = BUTTON_ZONE / 2
const SHUFFLE_CENTER = BUTTON_ZONE + BUTTON_ZONE / 2

const CLOCK_SIZE = 40
const CLOCK_WIDTH = 132
const CLOCK_LEFT = STRIP_WIDTH - CLOCK_WIDTH
const CLOCK_CENTER = CLOCK_LEFT + CLOCK_WIDTH / 2

const TEXT_LEFT = SHUFFLE_ZONE_RIGHT + 16
const TEXT_AVAILABLE = CLOCK_LEFT - 16 - TEXT_LEFT

// The strip's LCD only reports a tap once the finger lifts — there is no
// finger-down event — so a brief fading flash is the closest a button gets to a
// pressed state.
const FLASH_MILLISECONDS = 200
const FLASH_FRAME_MILLISECONDS = 30
const FLASH_PEAK = 0.24
const PRESSED_ICON = '#ffffff'
type Button = 'play' | 'shuffle'

const BACKDROP = ['#16222b', '#0b1116'] as const

const PLAYING_TITLE = '#ffffff'
const PAUSED_TITLE = '#78909c'
const SECONDARY = '#80deea'
const PLAY_ON = '#26c6da'
const PLAY_OFF = '#78909c'
const SHUFFLE_ON = '#80deea'
const SHUFFLE_OFF = '#37474f'
const CLOCK_COLOR = '#90a4ae'

export interface NowPlayingOptions {
    player: string
}

export function nowPlayingLines(
    player: HomeAssistantEntity | undefined,
    connected: boolean,
): { title: string; secondary: string; idle: boolean } {
    if (!connected || !player) return {title: 'NO MEDIA INFO', secondary: '', idle: true}

    const title = text(player.attributes.media_title)
    if (!title) return {title: 'NOTHING PLAYING', secondary: '', idle: true}

    const artist = text(player.attributes.media_artist) || text(player.attributes.media_album_artist)
    const album = text(player.attributes.media_album_name)
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
    #pressed: Button | null = null
    #pressedAt = 0

    constructor(ha: HomeAssistantService, clock: () => number, lva: LvaSender, model: ControlModel, {player}: NowPlayingOptions) {
        this.#ha = ha
        this.#clock = clock
        this.#player = requireEntity(player, 'now playing screen')
        this.#playPause = voiceBinding(lva, model, 'media_toggle')
        this.#shuffle = haBinding(ha, 'media_shuffle', this.#player)
    }

    mount(host: ScreenHost): void {
        this.#host = host
        this.#unwatch = this.#ha.watch([this.#player], () => host.invalidate())
    }

    applies(): boolean {
        return !nowPlayingLines(this.#ha.entity(this.#player), this.#ha.connected).idle
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
        this.#host = null
    }

    animationMilliseconds(): number | undefined {
        if (this.#flashing()) return FLASH_FRAME_MILLISECONDS
        const player = this.#ha.entity(this.#player)
        const {title} = nowPlayingLines(player, this.#ha.connected)
        if (overflows(title, fittingSize(title, TITLE_SIZES, TEXT_AVAILABLE), TEXT_AVAILABLE)) {
            return SCROLL_FRAME_MILLISECONDS
        }
        // Music Assistant reports a track's position once and then goes quiet, so
        // the bar needs its own tick to creep forward.
        const playing = player?.state === 'playing'
        return playing && hasPosition(player) ? POSITION_FRAME_MILLISECONDS : minuteTick(this.#clock())
    }

    pressAt(x: number): (() => unknown) | undefined {
        if (x < PLAY_ZONE_RIGHT) return this.#press('play', this.#playPause)
        if (x < SHUFFLE_ZONE_RIGHT) return this.#press('shuffle', this.#shuffle)
        return undefined
    }

    #press(button: Button, binding: Binding): () => unknown {
        this.#pressed = button
        this.#pressedAt = this.#clock()
        this.#host?.invalidate()
        return () => binding.run()
    }

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
        drawStripLine(surface, title, {
            centerY: secondary ? 36 : 46,
            size: fittingSize(title, TITLE_SIZES, TEXT_AVAILABLE),
            color: playing ? PLAYING_TITLE : PAUSED_TITLE,
            left: TEXT_LEFT,
            width: TEXT_AVAILABLE,
            now,
        })
        if (secondary) {
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

        const duration = numericAttribute(player, 'media_duration')
        const elapsed = mediaElapsedSeconds(player, now)
        if (hasPosition(player) && duration && elapsed !== undefined) {
            drawStripBar(surface, elapsed / duration, {color: playing ? '#26c6da' : '#37474f'})
        }
    }

    #drawButtons(surface: Surface, playing: boolean, shuffled: boolean): void {
        const flash = this.#flash()
        const play = {icon: (playing ? 'pause' : 'play') as IconName, color: playing ? PLAY_ON : PLAY_OFF}
        this.#drawButton(surface, 0, PLAY_CENTER, play.icon, play.color, this.#pressed === 'play' ? flash : 0)
        this.#drawButton(surface, BUTTON_ZONE, SHUFFLE_CENTER, 'shuffle', shuffled ? SHUFFLE_ON : SHUFFLE_OFF, this.#pressed === 'shuffle' ? flash : 0)
    }

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

function hasPosition(player: HomeAssistantEntity | undefined): boolean {
    const duration = numericAttribute(player, 'media_duration')
    return duration !== undefined && duration > 0 && numericAttribute(player, 'media_position') !== undefined
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}
