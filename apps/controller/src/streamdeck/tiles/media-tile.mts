// One dynamic key that plays or pauses the media player. It is built directly
// on the injected services and keeps everything about the key in one class:
// pressing it toggles the player, its face swaps between the play and pause
// glyphs with the playback state, and while playing it runs its own animation —
// the glyph breathes. It subscribes to the ControlModel while mounted so the
// pulse starts and stops with playback even when the change came from LVA
// rather than from this key.

import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { withAlpha, type Surface } from '../surface.mjs'
import { drawBackground, drawCaption, FACE_CENTER, type Tile, type TileContext, type TileHost } from './tile.mjs'
import type { ControlModel, Unsubscribe } from '../../state.mjs'
import type { Action } from '../../types.mjs'

/** How often the pulsing face is repainted while the player is playing. */
const PULSE_FRAME_MILLISECONDS = 150
/** One full breathe cycle of the pause glyph. */
const PULSE_PERIOD_MILLISECONDS = 1200

const ICON_SIZE = 58
/** How far the glyph swells over a cycle, as a fraction of its size. */
const PULSE_DEPTH = 0.07

/** The glyph size at an instant: a slow breathe around its resting size. */
function pulseSize(now: number): number {
  const phase = (now % PULSE_PERIOD_MILLISECONDS) / PULSE_PERIOD_MILLISECONDS
  return ICON_SIZE * (1 + PULSE_DEPTH * Math.sin(phase * 2 * Math.PI))
}

export class MediaTile implements Tile {
  private readonly model: ControlModel
  private readonly toggle: Binding
  private host: TileHost | null = null
  private unsubscribe: Unsubscribe | null = null
  private pulse: NodeJS.Timeout | null = null

  constructor(services: TileServices) {
    this.model = services.model
    this.toggle = createBindings(services).voice('media_toggle')
  }

  action(): Action {
    return this.toggle.action
  }

  press(): unknown {
    return this.toggle.run()
  }

  mount(host: TileHost): void {
    this.host = host
    this.unsubscribe = this.model.subscribe(() => this.followPlayback())
    this.followPlayback()
  }

  unmount(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.stopPulse()
    this.host = null
  }

  /** Run the pulse timer exactly while the player is playing. */
  private followPlayback(): void {
    if (this.model.state.media) this.startPulse()
    else this.stopPulse()
  }

  private startPulse(): void {
    if (this.pulse) return
    this.pulse = setInterval(() => this.host?.invalidate(), PULSE_FRAME_MILLISECONDS)
    // An animation must not keep the daemon alive on shutdown.
    this.pulse.unref()
  }

  private stopPulse(): void {
    if (this.pulse) clearInterval(this.pulse)
    this.pulse = null
  }

  draw(surface: Surface, { state, now }: TileContext): void {
    const playing = state.media
    drawBackground(surface, playing ? '#1b5e20' : '#10241a')
    const x = surface.width / 2
    if (playing) {
      surface.fill(surface.radialGradient(x, FACE_CENTER, 56, withAlpha('#a5d6a7', 0.18), withAlpha('#a5d6a7', 0)))
    }
    surface.icon(playing ? 'pause' : 'play', {
      x,
      y: FACE_CENTER,
      size: playing ? pulseSize(now) : ICON_SIZE,
      color: '#ffffff',
    })
    // The key names what the next press does, not what the player is doing.
    drawCaption(surface, playing ? 'PAUSE' : 'PLAY')
  }
}
