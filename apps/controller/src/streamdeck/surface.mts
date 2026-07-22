// The drawing surface every tile and screen paints on: a Skia canvas
// (@napi-rs/canvas) wrapped in the few operations this control surface actually
// repeats — a background wash, a line of text, an icon, a level bar.
//
// `ctx` is the real 2D context and tiles are meant to use it directly for
// anything beyond those: paths, clipping, transforms, shadows, and compositing
// are all available and need no wrapper. The helpers here exist so that the
// things every key does — centring a caption, tinting an icon, fitting a
// readout — are done the same way on all of them.
//
// A surface is reused rather than allocated per frame: the renderer keeps one
// key-sized and one strip-sized surface and calls `reset()` before each face.

import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import { fileURLToPath } from 'node:url'

import { iconImage } from './icons.mjs'
import type { IconName } from './icon-set.mjs'

/**
 * The one font family the deck draws in. Barlow Condensed is narrow enough
 * that an eight-character caption fits a 120px key at a readable size, which a
 * normal-width face does not.
 */
export const FONT = 'Deck'

/**
 * The gradient a canvas context produces. @napi-rs/canvas declares the type but
 * does not export it, so it is named here from the method that returns it.
 */
export type Gradient = ReturnType<SKRSContext2D['createLinearGradient']>

/** Weights registered under that family, named rather than numbered. */
export const REGULAR = 500
export const BOLD = 600

/**
 * Register the bundled font once per process. The Pi runs Raspberry Pi OS Lite,
 * which ships almost no fonts, so nothing here may fall back to a system face:
 * the deck would draw blank text on the Pi while looking correct in the
 * playground. Registering explicitly also keeps rendering identical between the
 * two, which is the whole point of having a playground.
 */
function registerFont(): void {
  if (GlobalFonts.families.some((family) => family.family === FONT)) return
  for (const file of ['BarlowCondensed-Medium.ttf', 'BarlowCondensed-SemiBold.ttf']) {
    // Resolved from this module so it works from both the compiled tree on the
    // Pi and dist/ on the control computer; `make build` copies assets/ beside
    // the compiled sources so the same relative path holds in each.
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)), FONT)
  }
}

registerFont()

/** A `#rrggbb` colour as its three channels. */
function channels(color: string): [number, number, number] {
  const value = Number.parseInt(color.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/**
 * A colour moved `amount` (0..1) of the way to white. Key backgrounds are
 * washed from a lightened shade down to the colour itself, so one colour per
 * state in a tile's config still produces a lit face rather than a flat block.
 */
export function lighten(color: string, amount: number): string {
  const shifted = channels(color).map((channel) => Math.round(channel + (255 - channel) * amount))
  return `#${shifted.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** The same colour at `alpha` opacity, for glows and overlays. */
export function withAlpha(color: string, alpha: number): string {
  return `rgba(${channels(color).join(',')},${alpha})`
}

/**
 * A canvas kept only for text metrics. Measuring has to set a font, and doing
 * that on a surface being painted would leak state into the next draw; it also
 * lets a screen ask whether a line will fit before it has a surface to draw on.
 */
const measurer = createCanvas(1, 1).getContext('2d')

/** How wide a line draws, so a caller can centre, fit, or scroll it. */
export function measureText(value: string, size: number, weight = BOLD): number {
  measurer.font = `${weight} ${size}px ${FONT}`
  return measurer.measureText(value).width
}

/**
 * The largest of `sizes` at which `value` fits `available`, or the smallest
 * offered. A readout picked this way stays as large as it can be instead of
 * shrinking every value to fit the longest one it might ever show.
 */
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
  /** Horizontal anchor: the centre unless `align` says otherwise. */
  x: number
  /** The vertical centre of the line, not its baseline. */
  y: number
  /** Cap height in pixels, near enough for laying a face out. */
  size: number
  color?: string
  weight?: number
  align?: 'center' | 'left' | 'right'
  /** Condense the line to fit this width rather than letting it overrun. */
  maxWidth?: number
  /** Draw at partial opacity, for a fading or dimmed line. */
  opacity?: number
}

export interface IconOptions {
  /** The icon's centre. */
  x: number
  y: number
  /** Width and height of the square the icon is drawn on. */
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
  /** Round the ends; a full-width bar across an edge usually should not be. */
  rounded?: boolean
}

export class Surface {
  readonly canvas: Canvas
  readonly ctx: SKRSContext2D

  constructor(readonly width: number, readonly height: number) {
    this.canvas = createCanvas(width, height)
    this.ctx = this.canvas.getContext('2d')
  }

  /**
   * Clear to `background` and drop whatever drawing state the last face left
   * behind, so a tile that forgets to restore a transform or an alpha cannot
   * corrupt the key drawn after it.
   */
  reset(background: string | Gradient = '#000000'): void {
    const { ctx } = this
    ctx.resetTransform()
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'
    ctx.clearRect(0, 0, this.width, this.height)
    this.fill(background)
  }

  /** Wash the whole surface in a colour or gradient. */
  fill(style: string | Gradient): void {
    this.ctx.fillStyle = style
    this.ctx.fillRect(0, 0, this.width, this.height)
  }

  /**
   * A top-to-bottom gradient across the whole surface. Key faces use one rather
   * than a flat colour: a lit key reads as lit from across the room, and the
   * caption bar at the foot sits against the darker end.
   */
  verticalGradient(from: string, to: string): Gradient {
    const gradient = this.ctx.createLinearGradient(0, 0, 0, this.height)
    gradient.addColorStop(0, from)
    gradient.addColorStop(1, to)
    return gradient
  }

  /** A soft radial glow behind an icon, for a key that is on. */
  radialGradient(x: number, y: number, radius: number, from: string, to: string): Gradient {
    const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, from)
    gradient.addColorStop(1, to)
    return gradient
  }

  /** How wide a line draws, so a caller can centre, fit, or scroll it. */
  measure(value: string, size: number, weight = BOLD): number {
    return measureText(value, size, weight)
  }

  /** The largest of `sizes` at which `value` fits `available`. */
  fittingSize(value: string, sizes: readonly number[], available: number, weight = BOLD): number {
    return fittingSize(value, sizes, available, weight)
  }

  /** One line of text, centred on `y` rather than sitting on a baseline. */
  text(value: string, options: TextOptions): void {
    const { ctx } = this
    const { x, y, size, color = '#ffffff', weight = BOLD, align = 'center', maxWidth, opacity } = options
    ctx.save()
    if (opacity !== undefined) ctx.globalAlpha = opacity
    ctx.font = `${weight} ${size}px ${FONT}`
    ctx.textAlign = align
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    // maxWidth condenses rather than clips, which keeps a slightly overlong
    // caption readable instead of cutting a word in half.
    if (maxWidth === undefined) ctx.fillText(value, x, y)
    else ctx.fillText(value, x, y, maxWidth)
    ctx.restore()
  }

  /**
   * An icon from the generated Hugeicons set, centred on (x, y) and tinted.
   * Rasterizing is cached per size and colour (streamdeck/icons.mts), so an
   * animated key redraws its icon without re-parsing any SVG.
   */
  icon(name: IconName, options: IconOptions): void {
    const { ctx } = this
    const { x, y, size, color, rotate, opacity } = options
    const image = iconImage(name, size, color)
    ctx.save()
    if (opacity !== undefined) ctx.globalAlpha = opacity
    ctx.translate(x, y)
    if (rotate) ctx.rotate(rotate * 2 * Math.PI)
    ctx.drawImage(image, -size / 2, -size / 2, size, size)
    ctx.restore()
  }

  /** A level bar: a track with the filled part of it drawn over the top. */
  bar(fraction: number, options: BarOptions): void {
    const { ctx } = this
    const { x, y, width, height, color = '#26c6da', track = '#1c2b33', rounded = false } = options
    const filled = Math.max(0, Math.min(1, fraction)) * width
    const radius = rounded ? height / 2 : 0
    ctx.fillStyle = track
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, radius)
    ctx.fill()
    if (filled <= 0) return
    ctx.fillStyle = color
    ctx.beginPath()
    // A rounded bar's fill must stay at least as wide as its own cap, or the
    // rounding draws a lens narrower than the value it stands for.
    ctx.roundRect(x, y, Math.max(filled, rounded ? height : 0), height, radius)
    ctx.fill()
  }

  /** Draw `paint` clipped to a rectangle, for revealing part of a face. */
  clipped(x: number, y: number, width: number, height: number, paint: () => void): void {
    const { ctx } = this
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, width, height)
    ctx.clip()
    paint()
    ctx.restore()
  }

  /**
   * The finished face as an RGBA buffer, which is what both the Stream Deck
   * and the playground take.
   *
   * The copy is not optional: `canvas.data()` hands back a view of the canvas's
   * own pixels, and writing a face to the deck is asynchronous, so without it
   * the next key painted on this surface would rewrite the image still being
   * sent for the last one.
   */
  snapshot(): Buffer {
    return Buffer.from(this.canvas.data())
  }
}
