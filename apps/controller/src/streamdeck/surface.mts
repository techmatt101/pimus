import {type Canvas, createCanvas, GlobalFonts, type SKRSContext2D} from '@napi-rs/canvas'
import {fileURLToPath} from 'node:url'

import {iconImage} from './icons.mjs'
import type {IconName} from './icon-set.mjs'

export const FONT = 'Deck'

/** @napi-rs/canvas declares this type but does not export it. */
export type Gradient = ReturnType<SKRSContext2D['createLinearGradient']>

export const REGULAR = 500
export const BOLD = 600

// Pi OS Lite ships almost no fonts, so nothing may fall back to a system face:
// the deck would draw blank text on the Pi while looking correct in the
// playground. The path resolves from this module because `make build` copies
// assets/ beside the compiled sources.
function registerFont(): void {
    if (GlobalFonts.families.some((family) => family.family === FONT)) return
    for (const file of ['BarlowCondensed-Medium.ttf', 'BarlowCondensed-SemiBold.ttf']) {
        GlobalFonts.registerFromPath(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)), FONT)
    }
}

registerFont()

function channels(color: string): [number, number, number] {
    const value = Number.parseInt(color.replace('#', ''), 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** A colour moved `amount` (0..1) of the way to white. */
export function lighten(color: string, amount: number): string {
    const shifted = channels(color).map((channel) => Math.round(channel + (255 - channel) * amount))
    return `#${shifted.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export function withAlpha(color: string, alpha: number): string {
    return `rgba(${channels(color).join(',')},${alpha})`
}

// Measuring has to set a font, and doing that on a surface mid-paint would leak
// state into the next draw, so metrics get their own throwaway canvas.
const measurer = createCanvas(1, 1).getContext('2d')

export function measureText(value: string, size: number, weight = BOLD): number {
    measurer.font = `${weight} ${size}px ${FONT}`
    return measurer.measureText(value).width
}

/** The largest of `sizes` at which `value` fits `available`, or the smallest offered. */
export function fittingSize(
    value: string,
    sizes: readonly number[],
    available: number,
    weight = BOLD,
): number {
    const ordered = [...sizes].sort((a, b) => b - a)
    return ordered.find((size) => measureText(value, size, weight) <= available) ?? Math.min(...sizes)
}

export interface TextOptions {
    x: number
    /** The vertical centre of the line, not its baseline. */
    y: number
    size: number
    color?: string
    weight?: number
    align?: 'center' | 'left' | 'right'
    /** Condense the line to fit this width rather than letting it overrun. */
    maxWidth?: number
    opacity?: number
}

export interface IconOptions {
    x: number
    y: number
    size: number
    color: string
    /** Turns clockwise from upright, so 0.25 is a quarter turn. */
    rotate?: number
    opacity?: number
}

export interface BarOptions {
    x: number
    y: number
    width: number
    height: number
    color?: string
    track?: string
    rounded?: boolean
}

export class Surface {
    readonly width: number
    readonly height: number
    readonly canvas: Canvas
    readonly ctx: SKRSContext2D

    constructor(width: number, height: number) {
        this.width = width
        this.height = height
        this.canvas = createCanvas(width, height)
        this.ctx = this.canvas.getContext('2d')
    }

    reset(background: string | Gradient = '#000000'): void {
        const {ctx} = this
        ctx.resetTransform()
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
        ctx.filter = 'none'
        ctx.shadowBlur = 0
        ctx.shadowColor = 'transparent'
        ctx.clearRect(0, 0, this.width, this.height)
        this.fill(background)
    }

    fill(style: string | Gradient): void {
        this.ctx.fillStyle = style
        this.ctx.fillRect(0, 0, this.width, this.height)
    }

    // The copy is not optional: `canvas.data()` is a view of the canvas's own
    // pixels, writes to the deck are asynchronous, and the surface is reused for
    // the next face.
    snapshot(): Buffer {
        return Buffer.from(this.canvas.data())
    }
}

export function verticalGradient(surface: Surface, from: string, to: string): Gradient {
    const gradient = surface.ctx.createLinearGradient(0, 0, 0, surface.height)
    gradient.addColorStop(0, from)
    gradient.addColorStop(1, to)
    return gradient
}

export function drawRadialGradient(
    surface: Surface,
    x: number,
    y: number,
    radius: number,
    from: string,
    to: string,
): Gradient {
    const gradient = surface.ctx.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, from)
    gradient.addColorStop(1, to)
    return gradient
}

export function drawText(surface: Surface, value: string, options: TextOptions): void {
    const {ctx} = surface
    const {x, y, size, color = '#ffffff', weight = BOLD, align = 'center', maxWidth, opacity} = options
    ctx.save()
    if (opacity !== undefined) ctx.globalAlpha = opacity
    ctx.font = `${weight} ${size}px ${FONT}`
    ctx.textAlign = align
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    if (maxWidth === undefined) ctx.fillText(value, x, y)
    else ctx.fillText(value, x, y, maxWidth)
    ctx.restore()
}

export function drawIcon(surface: Surface, name: IconName, options: IconOptions): void {
    const {ctx} = surface
    const {x, y, size, color, rotate, opacity} = options
    const image = iconImage(name, size, color)
    ctx.save()
    if (opacity !== undefined) ctx.globalAlpha = opacity
    ctx.translate(x, y)
    if (rotate) ctx.rotate(rotate * 2 * Math.PI)
    ctx.drawImage(image, -size / 2, -size / 2, size, size)
    ctx.restore()
}

export function drawBar(surface: Surface, fraction: number, options: BarOptions): void {
    const {ctx} = surface
    const {x, y, width, height, color = '#26c6da', track = '#1c2b33', rounded = false} = options
    const filled = Math.max(0, Math.min(1, fraction)) * width
    const radius = rounded ? height / 2 : 0
    ctx.fillStyle = track
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, radius)
    ctx.fill()
    if (filled <= 0) return
    ctx.fillStyle = color
    ctx.beginPath()
    // A rounded fill narrower than its own cap draws a lens smaller than the value.
    ctx.roundRect(x, y, Math.max(filled, rounded ? height : 0), height, radius)
    ctx.fill()
}

export function drawClipped(
    surface: Surface,
    x: number,
    y: number,
    width: number,
    height: number,
    paint: () => void,
): void {
    const {ctx} = surface
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, width, height)
    ctx.clip()
    paint()
    ctx.restore()
}
