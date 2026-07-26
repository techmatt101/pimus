import {repeatMode, requireEntity} from '../../actions/catalog.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {mediaElapsedSeconds, numericAttribute} from '../../home-assistant/entity.mjs'
import {drawIcon, fittingSize, REGULAR, type Surface} from '../surface.mjs'
import {
    type ClockFormat,
    drawClock,
    drawDate,
    drawStripBar,
    drawStripLine,
    minuteTick,
    overflows,
    type Screen,
    type ScreenHost,
    SCROLL_FRAME_MILLISECONDS,
    STRIP_WIDTH,
} from './screen.mjs'
import {drawStatusIcons, hasFault, STATUS_FLASH_FRAME_MILLISECONDS} from './status-icons.mjs'
import type {IconName} from '../icon-set.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

const TITLE_SIZES = [56, 46, 36]
const SECONDARY_SIZE = 24
const POSITION_FRAME_MILLISECONDS = 1000

const BUTTON_ICON = 44
const BUTTON_Y = 44
const BUTTON_ZONE = 96
const PLAY_ZONE_RIGHT = BUTTON_ZONE
const PLAY_CENTER = BUTTON_ZONE / 2

const CLOCK_SIZE = 40
const CLOCK_WIDTH = 132
const CLOCK_Y = 34
const CLOCK_LEFT = STRIP_WIDTH - CLOCK_WIDTH
const CLOCK_CENTER = CLOCK_LEFT + CLOCK_WIDTH / 2
const DATE_SIZE = 20
const DATE_Y = 68

const TEXT_LEFT = PLAY_ZONE_RIGHT + 16
const TEXT_AVAILABLE = CLOCK_LEFT - 16 - TEXT_LEFT

// Tapping the title swaps it for a transient row of transport extras that fades
// back to the title after a few idle seconds; each tap refreshes the countdown.
// `back` dismisses the row rather than acting, so it leads on the left.
const CONTROLS = ['back', 'shuffle', 'repeat'] as const
const CONTROLS_LEFT = PLAY_ZONE_RIGHT
const CONTROLS_SLOT = (CLOCK_LEFT - CONTROLS_LEFT) / CONTROLS.length
const CONTROLS_MILLISECONDS = 5000

// The strip's LCD only reports a tap once the finger lifts — there is no
// finger-down event — so a brief fading flash is the closest a button gets to a
// pressed state.
const FLASH_MILLISECONDS = 200
const FLASH_FRAME_MILLISECONDS = 30
const FLASH_PEAK = 0.24
const PRESSED_ICON = '#ffffff'
type Button = 'play' | (typeof CONTROLS)[number]

const BACKDROP = '#000000'

const PLAYING_TITLE = '#ffffff'
const PAUSED_TITLE = '#78909c'
const SECONDARY = '#80deea'
const PLAY_ON = '#26c6da'
const PLAY_OFF = '#78909c'
const TOGGLE_ON = '#80deea'
const TOGGLE_OFF = '#37474f'
const BACK_COLOR = '#b0bec5'
const CLOCK_COLOR = '#90a4ae'

export interface NowPlayingOptions {
    player: string
    clockFormat?: ClockFormat
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

const FAULT_ICON_SIZE = 14
const FAULT_ICON_GAP = 8
const FAULT_ICON_Y = 88

export class NowPlayingScreen implements Screen {
    readonly #ha: HomeAssistantService
    readonly #model: ControlModel
    readonly #clock: () => number
    readonly #player: string
    readonly #playPause: Binding
    readonly #controls: {shuffle: Binding; repeat: Binding}
    readonly #clockFormat: ClockFormat
    #host: ScreenHost | null = null
    #unwatch: (() => void) | null = null
    #pressed: Button | null = null
    #pressedAt = 0
    #controlsShownAt: number | null = null

    constructor(ha: HomeAssistantService, model: ControlModel, clock: () => number, {player, clockFormat = '12h'}: NowPlayingOptions) {
        this.#ha = ha
        this.#model = model
        this.#clock = clock
        this.#player = requireEntity(player, 'now playing screen')
        this.#playPause = haBinding(ha, 'media_play_pause', this.#player)
        this.#controls = {
            shuffle: haBinding(ha, 'media_shuffle', this.#player),
            repeat: haBinding(ha, 'media_repeat', this.#player),
        }
        this.#clockFormat = clockFormat
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
        this.#controlsShownAt = null
        this.#pressed = null
    }

    animationMilliseconds(): number | undefined {
        const player = this.#ha.entity(this.#player)
        const frames = [minuteTick(this.#clock())]
        if (this.#flashing()) frames.push(FLASH_FRAME_MILLISECONDS)
        if (hasFault(this.#model.state)) frames.push(STATUS_FLASH_FRAME_MILLISECONDS)
        // A wake at the moment the extras time out repaints the title back in.
        const controlsLeft = this.#controlsRemaining()
        if (controlsLeft > 0) frames.push(controlsLeft)
        else {
            const {title} = nowPlayingLines(player, this.#ha.connected)
            if (overflows(title, fittingSize(title, TITLE_SIZES, TEXT_AVAILABLE), TEXT_AVAILABLE)) {
                frames.push(SCROLL_FRAME_MILLISECONDS)
            }
        }
        // Music Assistant reports a track's position once and then goes quiet, so
        // the bar needs its own tick to creep forward.
        if (player?.state === 'playing' && hasPosition(player)) frames.push(POSITION_FRAME_MILLISECONDS)
        return Math.min(...frames)
    }

    pressAt(x: number): (() => unknown) | undefined {
        if (x < PLAY_ZONE_RIGHT) return this.#press('play', this.#playPause)
        // The clock corner has no button, so swallow the tap rather than let it
        // fall through to the dial zone beneath it.
        if (x >= CLOCK_LEFT) return () => {}
        if (!this.#controlsShown()) {
            this.#controlsShownAt = this.#clock()
            this.#host?.invalidate()
            return () => {}
        }
        const slot = Math.min(CONTROLS.length - 1, Math.max(0, Math.floor((x - CONTROLS_LEFT) / CONTROLS_SLOT)))
        const button = CONTROLS[slot] as (typeof CONTROLS)[number]
        if (button === 'back') {
            this.#controlsShownAt = null
            this.#host?.invalidate()
            return () => {}
        }
        this.#controlsShownAt = this.#clock()
        return this.#press(button, this.#controls[button])
    }

    #press(button: Button, binding: Binding): () => unknown {
        this.#pressed = button
        this.#pressedAt = this.#clock()
        this.#host?.invalidate()
        return () => binding.run()
    }

    #controlsRemaining(): number {
        if (this.#controlsShownAt === null) return 0
        return Math.max(0, CONTROLS_MILLISECONDS - (this.#clock() - this.#controlsShownAt))
    }

    #controlsShown(): boolean {
        return this.#controlsRemaining() > 0
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
        const playing = player?.state === 'playing'
        surface.fill(BACKDROP)

        if (this.#controlsShown()) this.#drawControls(surface, player)
        else this.#drawTrack(surface, player, playing, now)

        const play = (playing ? 'pause' : 'play') as IconName
        this.#drawButton(surface, PLAY_CENTER, BUTTON_ZONE, play, playing ? PLAY_ON : PLAY_OFF, this.#pressed === 'play')
        drawClock(surface, now, this.#clockFormat, {centerX: CLOCK_CENTER, y: CLOCK_Y, size: CLOCK_SIZE, color: CLOCK_COLOR})
        drawDate(surface, now, {centerX: CLOCK_CENTER, y: DATE_Y, size: DATE_SIZE, color: CLOCK_COLOR})

        const duration = numericAttribute(player, 'media_duration')
        const elapsed = mediaElapsedSeconds(player, now)
        if (hasPosition(player) && duration && elapsed !== undefined) {
            drawStripBar(surface, elapsed / duration, {color: playing ? '#26c6da' : '#37474f'})
        }

        drawStatusIcons(surface, this.#model.state, {
            x: CLOCK_LEFT + FAULT_ICON_SIZE / 2,
            y: FAULT_ICON_Y,
            size: FAULT_ICON_SIZE,
            gap: FAULT_ICON_GAP,
            now,
            alertsOnly: true,
        })
    }

    #drawTrack(surface: Surface, player: HomeAssistantEntity | undefined, playing: boolean, now: number): void {
        const {title, secondary} = nowPlayingLines(player, this.#ha.connected)
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
    }

    #drawControls(surface: Surface, player: HomeAssistantEntity | undefined): void {
        const repeat = this.#ha.connected ? repeatMode(this.#ha, this.#player) : 'off'
        const face: Record<(typeof CONTROLS)[number], { icon: IconName; color: string }> = {
            shuffle: {icon: 'shuffle', color: player?.attributes.shuffle ? TOGGLE_ON : TOGGLE_OFF},
            repeat: {icon: repeat === 'one' ? 'repeatOne' : 'repeat', color: repeat === 'off' ? TOGGLE_OFF : TOGGLE_ON},
            back: {icon: 'previous', color: BACK_COLOR},
        }
        CONTROLS.forEach((button, slot) => {
            const {icon, color} = face[button]
            this.#drawButton(surface, CONTROLS_LEFT + CONTROLS_SLOT * (slot + 0.5), CONTROLS_SLOT, icon, color, this.#pressed === button)
        })
    }

    #drawButton(surface: Surface, center: number, zoneWidth: number, icon: IconName, color: string, pressed: boolean): void {
        const flash = pressed ? this.#flash() : 0
        if (flash > 0) {
            const {ctx} = surface
            ctx.save()
            ctx.globalAlpha = flash * FLASH_PEAK
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.roundRect(center - zoneWidth / 2 + 10, BUTTON_Y - 34, zoneWidth - 20, 68, 14)
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
