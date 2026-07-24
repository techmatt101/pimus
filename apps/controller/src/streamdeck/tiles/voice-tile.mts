// One key for both directions of a voice interaction: press it to start Assist,
// press it again to cancel the pipeline that is running. The face says which of
// those the next press will do, and while a pipeline is live the microphone
// sits inside expanding rings so you can see the deck is listening from across
// the room.

import { isAssistRunning } from '../../actions/catalog.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { icon, withAlpha, type Surface } from '../surface.mjs'
import { drawBackground, drawCaption, FACE_CENTER, type Tile, type TileHost } from './tile.mjs'
import type { ControlModel, Unsubscribe } from '../../state.mjs'
import type { Action } from '../../types.mjs'

/** How often the listening face is repainted while a pipeline is running. */
const FRAME_MILLISECONDS = 120
/** One full outward sweep of the rings. */
const RIPPLE_PERIOD_MILLISECONDS = 1600
/** How far a ring travels before it has faded out. */
const RIPPLE_RADIUS = 52

export class VoiceTile implements Tile {
  private readonly model: ControlModel
  private readonly toggle: Binding
  private host: TileHost | null = null
  private unsubscribe: Unsubscribe | null = null
  private ripple: NodeJS.Timeout | null = null
  // The ripple's phase, accumulated from the deltaTime each draw is handed
  // rather than read from a wall clock, so the sweep advances by real elapsed
  // time however often the tile happens to repaint.
  private phase = 0

  constructor(services: TileServices) {
    this.model = services.model
    this.toggle = createBindings(services).voice('listen_toggle')
  }

  action(): Action {
    return this.toggle.action
  }

  press(): unknown {
    return this.toggle.run()
  }

  mount(host: TileHost): void {
    this.host = host
    this.unsubscribe = this.model.subscribe(() => this.followAssist())
    this.followAssist()
  }

  unmount(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.stopRipple()
    this.host = null
  }

  /** Run the ripple exactly while a pipeline is live, however it was started. */
  private followAssist(): void {
    if (isAssistRunning(this.model.state)) this.startRipple()
    else this.stopRipple()
  }

  private startRipple(): void {
    if (this.ripple) return
    // Start each listening session from a still ring rather than wherever the
    // last one left the phase.
    this.phase = 0
    this.ripple = setInterval(() => this.host?.invalidate(), FRAME_MILLISECONDS)
    // An animation must not keep the daemon alive on shutdown.
    this.ripple.unref()
  }

  private stopRipple(): void {
    if (this.ripple) clearInterval(this.ripple)
    this.ripple = null
  }

  draw(surface: Surface, deltaTime: number): void {
    const running = isAssistRunning(this.model.state)
    drawBackground(surface, running ? '#006064' : '#00272b')
    const x = surface.width / 2

    if (running) {
      // Two rings a half-cycle apart, each fading as it grows, so the sweep
      // reads as continuous rather than restarting.
      const { ctx } = surface
      this.phase += deltaTime
      const phase = (this.phase % RIPPLE_PERIOD_MILLISECONDS) / RIPPLE_PERIOD_MILLISECONDS
      ctx.save()
      ctx.lineWidth = 3
      for (const offset of [0, 0.5]) {
        const step = (phase + offset) % 1
        ctx.strokeStyle = withAlpha('#00e5ff', 1 - step)
        ctx.beginPath()
        ctx.arc(x, FACE_CENTER, 18 + step * RIPPLE_RADIUS, 0, 2 * Math.PI)
        ctx.stroke()
      }
      ctx.restore()
    }

    icon(surface, 'mic', {
      x,
      y: FACE_CENTER,
      size: 52,
      color: running ? '#ffffff' : '#4dd0e1',
    })
    drawCaption(surface, running ? 'CANCEL' : 'VOICE')
  }
}
