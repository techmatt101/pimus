import {drawBar, BOLD, drawClipped, measureText, type Surface, drawText} from '../surface.mjs'

export const STRIP_WIDTH = 800
export const STRIP_HEIGHT = 100
export const STRIP_MARGIN = 24

const SCROLL_PIXELS_PER_SECOND = 55
const SCROLL_GAP = 80
export const SCROLL_FRAME_MILLISECONDS = 80

export interface ScreenHost {
    /** Repaint the strip, outside the shared render schedule. */
    invalidate(): void

    /** Whether faces may move; a dimmed panel holds every animation still. */
    animating(): boolean
}

export interface Screen {
    draw(surface: Surface, deltaTime: number): void

    /** How often to repaint while visible, or undefined when the face is static. */
    animationMilliseconds?(): number | undefined

    mount?(host: ScreenHost): void

    unmount?(): void

    /**
     * A tap at strip x-coordinate `x` while this screen is showing. Returns a
     * thunk to run, or undefined to let the strip fall back to the dial in that
     * zone. A thunk rather than acting keeps presses in physical order through
     * the deck's dispatch queue.
     */
    pressAt?(x: number): (() => unknown) | undefined

    /**
     * For a resting candidate: whether it should be the resting face right now.
     * A screen without this method always applies, so the last candidate can be
     * a catch-all.
     */
    applies?(): boolean
}

export interface StripLineOptions {
    centerY: number
    size: number
    color?: string
    /** Animation time accumulated by the screen, which is what moves a scrolling line. */
    phase?: number
    margin?: number
    /** Left-align rather than centre, for a line that shares a row with something else. */
    left?: number
    /** The width the line has before it scrolls; defaults to the strip between its margins. */
    width?: number
    opacity?: number
    weight?: number
}

/**
 * One line of text across the strip: centred while it fits, sliding leftwards
 * when it does not. Returns whether it is scrolling, which is how a screen
 * decides to ask for animation frames.
 */
export function drawStripLine(surface: Surface, value: string, options: StripLineOptions): boolean {
    const {centerY, size, color = '#ffffff', phase = 0, margin = STRIP_MARGIN, left, width, opacity, weight = BOLD} = options
    const start = left ?? margin
    const available = width ?? surface.width - margin - start
    const measured = measureText(value, size, weight)
    const line = {y: centerY, size, color, opacity, weight, align: 'left' as const}

    if (measured <= available) {
        const x = left ?? Math.round((surface.width - measured) / 2)
        drawText(surface, value, {...line, x})
        return false
    }

    // The line and one repeat slide together so the text runs continuously,
    // clipped to its own region so it never runs under whatever shares its row.
    const cycle = measured + SCROLL_GAP
    const offset = ((phase / 1000) * SCROLL_PIXELS_PER_SECOND) % cycle
    const origin = start - offset
    drawClipped(surface, start, centerY - size, available, size * 2, () => {
        drawText(surface, value, {...line, x: origin})
        drawText(surface, value, {...line, x: origin + cycle})
    })
    return true
}

/** Whether `value` is too wide for `available` and would therefore scroll. */
export function overflows(value: string, size: number, available = STRIP_WIDTH - STRIP_MARGIN * 2): boolean {
    return measureText(value, size) > available
}

const MINUTE = 60_000

/**
 * Milliseconds until the next minute boundary. Re-computing it each paint
 * re-arms the strip's frame timer on the minute rather than drifting a fixed
 * minute off it.
 */
export function minuteTick(now: number): number {
    return MINUTE - (now % MINUTE)
}

export type ClockFormat = '24h' | '12h'

export interface ClockStyle {
    /** The horizontal centre the time and any AM/PM are balanced around. */
    centerX: number
    y: number
    size: number
    color?: string
}

/**
 * The clock, centred around `centerX`: the time at `size`, and in 12-hour format
 * a smaller AM/PM riding against its bottom edge. Returns the drawn span so a caller
 * can place something beside it. `getHours()` reads the host's own local time.
 */
export function drawClock(surface: Surface, now: number, format: ClockFormat, style: ClockStyle): { left: number; right: number } {
    const {centerX, y, size, color = '#ffffff'} = style
    const at = new Date(now)
    const minutes = String(at.getMinutes()).padStart(2, '0')
    const twelveHour = format === '12h'
    const hours = twelveHour ? String(((at.getHours() + 11) % 12) + 1) : String(at.getHours()).padStart(2, '0')
    const time = `${hours}:${minutes}`

    const timeWidth = measureText(time, size)
    const meridiemSize = Math.round(size * 0.42)
    const gap = Math.round(size * 0.16)
    const meridiem = twelveHour ? (at.getHours() < 12 ? 'AM' : 'PM') : undefined
    const meridiemWidth = meridiem ? gap + measureText(meridiem, meridiemSize) : 0

    const left = centerX - (timeWidth + meridiemWidth) / 2
    drawText(surface, time, {x: left, y, size, color, align: 'left'})
    if (meridiem) {
        drawText(surface, meridiem, {x: left + timeWidth + gap, y: y + (size - meridiemSize * 1.5) / 2, size: meridiemSize, color, align: 'left'})
    }
    return {left, right: left + timeWidth + meridiemWidth}
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export interface DateStyle {
    centerX: number
    y: number
    size: number
    color?: string
}

/** The date, e.g. `Sat 25 Jul`, read from the host's local time. */
export function formatDate(now: number): string {
    const at = new Date(now)
    return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`
}

export function drawDate(surface: Surface, now: number, {centerX, y, size, color = '#90a4ae'}: DateStyle): void {
    drawText(surface, formatDate(now), {x: centerX, y, size, color})
}

/** A progress bar along the bottom edge. `fraction` is clamped. */
export function drawStripBar(
    surface: Surface,
    fraction: number,
    {color = '#26c6da', track = '#1c2b33', height = 6}: { color?: string; track?: string; height?: number } = {},
): void {
    drawBar(surface, fraction, {
        x: 0,
        y: surface.height - height,
        width: surface.width,
        height,
        color,
        track,
    })
}
