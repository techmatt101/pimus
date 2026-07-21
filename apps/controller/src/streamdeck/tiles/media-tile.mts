// One dynamic key that plays or pauses the media player. It is built directly
// on the injected services and keeps everything about the key in one class:
// pressing it toggles the player, its face swaps between a play triangle and
// pause bars with the playback state, and while playing it runs its own
// animation — the pause bars breathe. It subscribes to the ControlModel while
// mounted so the pulse starts and stops with playback even when the change
// came from LVA rather than from this key.

import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { drawRectangle } from '../bitmap.mjs'
import { labelTile, type Tile, type TileContext, type TileHost } from './tile.mjs'
import type { ControlModel, Unsubscribe } from '../../state.mjs'
import type { Action, Bitmap } from '../../types.mjs'

/** How often the pulsing face is repainted while the player is playing. */
const PULSE_FRAME_MILLISECONDS = 150
/** One full breathe cycle of the pause bars. */
const PULSE_PERIOD_MILLISECONDS = 1200

/** A right-pointing play triangle, drawn scanline by scanline. */
function drawPlayIcon(target: Bitmap, centerX: number, centerY: number): void {
  const half = 22
  const left = centerX - 15
  for (let dy = -half; dy <= half; dy += 1) {
    const width = Math.max(1, Math.round((1 - Math.abs(dy) / half) * 32))
    drawRectangle(target, left, centerY + dy, width, 1, '#ffffff')
  }
}

/** Two vertical pause bars, `height` pixels tall. */
function drawPauseIcon(target: Bitmap, centerX: number, centerY: number, height: number): void {
  const barWidth = 10
  const gap = 12
  drawRectangle(target, centerX - gap / 2 - barWidth, centerY - height / 2, barWidth, height, '#ffffff')
  drawRectangle(target, centerX + gap / 2, centerY - height / 2, barWidth, height, '#ffffff')
}

/** The bar height at an instant: a slow breathe around the resting 44px. */
function pulseHeight(now: number): number {
  const phase = (now % PULSE_PERIOD_MILLISECONDS) / PULSE_PERIOD_MILLISECONDS
  return 44 + Math.round(6 * Math.sin(phase * 2 * Math.PI))
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

  render({ state, now }: TileContext): Bitmap {
    const playing = state.media
    const face = labelTile(playing ? '#1b5e20' : '#10241a', playing ? 'PAUSE' : 'PLAY')
    if (playing) drawPauseIcon(face, 60, 46, pulseHeight(now))
    else drawPlayIcon(face, 60, 46)
    return face
  }
}
