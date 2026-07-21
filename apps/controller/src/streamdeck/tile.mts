// A tile is one key on the Stream Deck grid. It owns two things: the action it
// dispatches when pressed, and how it paints its own 120x120 face for the
// current state. Most keys are a plain `ActionTile` whose face comes from the
// bound action's catalog indicator, but a tile that needs richer, stateful
// rendering — its own icons, styling, or animation — is a `Tile` subclass. The
// `MediaTile` is the first of those: a single play/pause key that swaps its icon
// and colour with the playback state instead of being two separate buttons.

import { indicatorFor } from '../actions/catalog.mjs'
import { createImage, drawRectangle, drawText } from './bitmap.mjs'
import type { Action, AudioState, Bitmap, ControlState } from '../types.mjs'

/** The live state a tile consults to decide its face and, if needed, its action. */
export interface TileContext {
  state: ControlState
  audio: AudioState
}

/** A key on the grid: what it does when pressed, and how it draws itself. */
export abstract class Tile {
  /** The action to dispatch on press, or undefined to do nothing. */
  abstract action(context: TileContext): Action | undefined
  /** The 120x120 key face to show for the current state. */
  abstract render(context: TileContext): Bitmap
}

/** The computed face of a labelled key: its caption and background colour. */
export interface KeyAppearance {
  label: string
  background: string
}

/** The standard key face: a centred label over a black caption bar. */
export function labelTile(background: string, label: string): Bitmap {
  const face = createImage(120, 120, background)
  drawRectangle(face, 0, 94, 120, 26, '#000000')
  drawText(face, label, 60, 106, label.length > 8 ? 2 : 3)
  return face
}

export interface ActionTileConfig {
  label: string
  color: string
  action?: Action
}

/**
 * The appearance of a labelled key, derived entirely from its bound action's
 * catalog indicator. An action with no indicator keeps its configured label and
 * colour; the mute, media, listen, and route indicators drive their own.
 */
export function actionAppearance(config: ActionTileConfig, context: TileContext): KeyAppearance {
  const indicator = indicatorFor(config.action)
  if (!indicator) return { label: config.label, background: config.color }

  const active = indicator.isActive({ state: context.state, audio: context.audio, source: config.action?.source })
  return {
    label: indicator.label ? indicator.label(config.label, active) : config.label,
    background: active ? indicator.activeColor : config.color,
  }
}

/**
 * The default key: a fixed label and colour bound to one action, with any
 * active-state feedback coming from the action's catalog indicator. This is the
 * tile to reach for unless a key needs rendering the indicator cannot express.
 */
export class ActionTile extends Tile {
  constructor(private readonly config: ActionTileConfig) {
    super()
  }

  action(): Action | undefined {
    return this.config.action
  }

  render(context: TileContext): Bitmap {
    const { label, background } = actionAppearance(this.config, context)
    return labelTile(background, label)
  }
}

const MEDIA_TOGGLE: Action = { type: 'lva', command: 'media_toggle' }

/** A right-pointing play triangle, drawn scanline by scanline. */
function drawPlayIcon(target: Bitmap, centerX: number, centerY: number): void {
  const half = 22
  const left = centerX - 15
  for (let dy = -half; dy <= half; dy += 1) {
    const width = Math.max(1, Math.round((1 - Math.abs(dy) / half) * 32))
    drawRectangle(target, left, centerY + dy, width, 1, '#ffffff')
  }
}

/** Two vertical pause bars. */
function drawPauseIcon(target: Bitmap, centerX: number, centerY: number): void {
  const barWidth = 10
  const gap = 12
  const height = 44
  drawRectangle(target, centerX - gap / 2 - barWidth, centerY - height / 2, barWidth, height, '#ffffff')
  drawRectangle(target, centerX + gap / 2, centerY - height / 2, barWidth, height, '#ffffff')
}

/**
 * One dynamic key that plays or pauses the media player. It reads the playback
 * state to choose its icon, label, and colour, so the two former PLAY and STOP
 * faces collapse into a single button whose look tracks what the player is
 * doing. Richer feedback (a pulsing icon while playing, say) belongs here too,
 * in `render`, rather than back in the shared renderer.
 */
export class MediaTile extends Tile {
  action(): Action {
    return MEDIA_TOGGLE
  }

  render({ state }: TileContext): Bitmap {
    const playing = state.media
    const face = labelTile(playing ? '#1b5e20' : '#10241a', playing ? 'PAUSE' : 'PLAY')
    if (playing) drawPauseIcon(face, 60, 46)
    else drawPlayIcon(face, 60, 46)
    return face
  }
}
