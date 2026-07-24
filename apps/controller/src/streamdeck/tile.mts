import {fittingSize, lighten, type Surface, drawText, verticalGradient, withAlpha} from './surface.mjs'
import type {Action} from '../types.mjs'

export const KEY_SIZE = 120

export const CAPTION_TOP = 92
export const CAPTION_HEIGHT = KEY_SIZE - CAPTION_TOP
const CAPTION_CENTER = CAPTION_TOP + CAPTION_HEIGHT / 2
const CAPTION_SIZE = 19
const CAPTION_WIDTH = KEY_SIZE - 8

/** The centre of the area above the caption, where a tile's subject goes. */
export const FACE_CENTER = 44

export interface TileHost {
    /** Repaint just this tile's key face, outside the shared render schedule. */
    invalidate(): void

    changePage(delta: number): void

    /** The name of the page `delta` steps away, for a navigation key's face. */
    pageName(delta: number): string
}

export interface Tile {
    /** Performs the key's behaviour. Runs through the deck's dispatch queue. */
    press(): void

    /**
     * Paint the key face. The surface arrives cleared and is reused for the next
     * key, so nothing may be held on to after this returns. `deltaTime` is the
     * milliseconds since this face last drew.
     */
    draw(surface: Surface, deltaTime: number): void

    /** The declarative action this tile stands for, for catalog validation. */
    action?(): Action | undefined

    mount?(host: TileHost): void

    unmount?(): void
}

export function drawBackground(surface: Surface, background: string): void {
    surface.fill(verticalGradient(surface, lighten(background, 0.16), background))
}

/** The black caption bar every key face shares, so labels line up across the grid. */
export function drawCaption(surface: Surface, label: string, color = '#ffffff'): void {
    surface.ctx.fillStyle = 'rgba(0,0,0,0.72)'
    surface.ctx.fillRect(0, CAPTION_TOP, surface.width, CAPTION_HEIGHT)
    drawText(surface, label, {
        x: surface.width / 2,
        y: CAPTION_CENTER,
        size: CAPTION_SIZE,
        color,
        maxWidth: CAPTION_WIDTH,
    })
}

export function drawLabelFace(surface: Surface, background: string, label: string): void {
    drawBackground(surface, background)
    drawCaption(surface, label)
}

/** A dot per choice with the current one filled, for a key that cycles a short list. */
export function drawDots(
    surface: Surface,
    count: number,
    current: number,
    y: number,
    color: string,
    spacing = 15,
): void {
    const {ctx} = surface
    const left = surface.width / 2 - ((count - 1) * spacing) / 2
    ctx.save()
    ctx.lineWidth = 1.5
    for (let position = 0; position < count; position += 1) {
        ctx.beginPath()
        ctx.arc(left + position * spacing, y, 3.5, 0, 2 * Math.PI)
        if (position === current) {
            ctx.fillStyle = color
            ctx.fill()
        } else {
            ctx.strokeStyle = withAlpha(color, 0.55)
            ctx.stroke()
        }
    }
    ctx.restore()
}

/** One large reading, shrunk only as far as the value needs. */
export function drawValue(surface: Surface, value: string, x: number, y: number, available = KEY_SIZE - 12): void {
    drawText(surface, value, {x, y, size: fittingSize(value, [46, 38, 30, 24], available)})
}

const ACTIVE_GLOW = '#26c6da'

/** A glowing border marking the key that currently holds the shared dial. */
export function drawActiveGlow(surface: Surface, color = ACTIVE_GLOW): void {
    const {ctx} = surface
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 4
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    // Inset by half the stroke so the whole 4px line lands on the face.
    ctx.strokeRect(2, 2, surface.width - 4, surface.height - 4)
    ctx.restore()
}
