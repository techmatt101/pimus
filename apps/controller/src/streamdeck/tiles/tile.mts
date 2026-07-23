// The Tile contract: one key on the Stream Deck grid. A tile owns what
// pressing it does and how it paints its own 120x120 face, and may opt into a
// lifecycle for richer behaviour. Each tile class lives in its own file in
// this folder; tiles are created by the layout factory (streamdeck/layout.mts)
// with the controller's services injected, so a tile carries its behaviour
// with it instead of handing a description to a central dispatcher.
//
// A tile paints onto a Surface (streamdeck/surface.mts) the renderer owns and
// reuses, rather than returning an image of its own. The shared faces below —
// a labelled key, a readout key, the caption bar — are what keep eight
// independently written keys looking like one control surface.

import { lighten, withAlpha, type Surface } from '../surface.mjs'
import type { Action, AudioState, ControlState } from '../../types.mjs'

/** The pixel size of one key face. */
export const KEY_SIZE = 120

/** The caption bar at the foot of every key, and where its text sits. */
export const CAPTION_TOP = 92
export const CAPTION_HEIGHT = KEY_SIZE - CAPTION_TOP
const CAPTION_CENTER = CAPTION_TOP + CAPTION_HEIGHT / 2
const CAPTION_SIZE = 19
/** Captions are condensed to fit rather than overrunning the key. */
const CAPTION_WIDTH = KEY_SIZE - 8

/** The centre of the area above the caption, where a tile's subject goes. */
export const FACE_CENTER = 44

/** The live state a tile consults to decide its face and behaviour. */
export interface TileContext {
  state: ControlState
  audio: AudioState
  /**
   * The wall-clock instant of this repaint, for animated faces. Deriving an
   * animation phase from `now` keeps drawing a pure function of its context —
   * a tile only needs its own timer to *request* repaints (see TileHost).
   */
  now: number
}

/** What a mounted tile may ask of the renderer. */
export interface TileHost {
  /** Repaint just this tile's key face, outside the shared render schedule. */
  invalidate(): void
  /**
   * Move by whole pages, the same as the bottom-corner navigation keys. A tile
   * only ever has a host while it is the visible page, so this is safe to call
   * from a press.
   */
  changePage(delta: number): void
  /** The name of the page `delta` steps away, for a navigation key's face. */
  pageName(delta: number): string
}

/**
 * A key on the grid: what pressing it does, and how it draws itself.
 *
 * `mount` is called when the tile becomes visible on an attached deck, and
 * `unmount` when its page navigates away or the deck disconnects. A tile that
 * keeps its own state may subscribe to the ControlModel in `mount` to react to
 * changes, and drive its own animation by running a timer that calls
 * `host.invalidate()` — it must drop both in `unmount`.
 */
export interface Tile {
  /** Performs the key's behaviour. Runs through the deck's dispatch queue. */
  press(context: TileContext): unknown
  /**
   * Paint the key face for the current state. The surface arrives cleared, so
   * a tile draws everything it wants to show; the renderer reuses it for the
   * next key, so nothing may be held on to after this returns.
   */
  draw(surface: Surface, context: TileContext): void
  /**
   * The declarative action this tile stands for, if any; layout.test.mts
   * validates it against the catalog. A tile whose behaviour the catalog
   * cannot express omits this or returns undefined.
   */
  action?(): Action | undefined
  /** Called when this tile becomes visible on an attached deck. */
  mount?(host: TileHost): void
  /** Called when the page changes away or the deck disconnects. */
  unmount?(): void
}

/**
 * Wash the key in its background colour. Every face starts here: the wash runs
 * from a lightened shade at the top down to the colour itself, so a lit key
 * reads as lit from across the room rather than as a flat block.
 */
export function drawBackground(surface: Surface, background: string): void {
  surface.fill(surface.verticalGradient(lighten(background, 0.16), background))
}

/** The black caption bar every key face shares, so labels line up across the grid. */
export function drawCaption(surface: Surface, label: string, color = '#ffffff'): void {
  surface.ctx.fillStyle = 'rgba(0,0,0,0.72)'
  surface.ctx.fillRect(0, CAPTION_TOP, surface.width, CAPTION_HEIGHT)
  surface.text(label, {
    x: surface.width / 2,
    y: CAPTION_CENTER,
    size: CAPTION_SIZE,
    color,
    maxWidth: CAPTION_WIDTH,
  })
}

/** The standard key face: a background with a caption along the foot. */
export function drawLabelFace(surface: Surface, background: string, label: string): void {
  drawBackground(surface, background)
  drawCaption(surface, label)
}

/**
 * A dot per choice with the current one filled, for a key that cycles through a
 * short list — the scenes, the audio inputs. It says how many presses it takes
 * to get back around without having to cycle through and find out.
 */
export function drawDots(
  surface: Surface,
  count: number,
  current: number,
  y: number,
  color: string,
  spacing = 15,
): void {
  const { ctx } = surface
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
  surface.text(value, { x, y, size: surface.fittingSize(value, [46, 38, 30, 24], available) })
}
