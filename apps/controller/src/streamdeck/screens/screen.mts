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
    /** The instant of this repaint, which is what moves a scrolling line. */
    now?: number
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
    const {centerY, size, color = '#ffffff', now = 0, margin = STRIP_MARGIN, left, width, opacity, weight = BOLD} = options
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
    const offset = ((now / 1000) * SCROLL_PIXELS_PER_SECOND) % cycle
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

export function clockTime(now: number): string {
    const at = new Date(now)
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
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
