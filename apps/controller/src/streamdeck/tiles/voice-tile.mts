// One key for both directions of a voice interaction: press it to start Assist,
// press it again to cancel the pipeline that is running. The face says which of
// those the next press will do, and while a pipeline is live the microphone
// sits inside expanding rings so you can see the deck is listening from across
// the room.

import { isAssistRunning } from '../../actions/catalog.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { drawCircle } from '../bitmap.mjs'
import { micIcon } from '../icons.mjs'
import { labelTile, type Tile, type TileContext, type TileHost } from './tile.mjs'
import type { ControlModel, Unsubscribe } from '../../state.mjs'
import type { Action, Bitmap } from '../../types.mjs'

/** How often the listening face is repainted while a pipeline is running. */
const FRAME_MILLISECONDS = 120
/** One full outward sweep of the rings. */
const RIPPLE_PERIOD_MILLISECONDS = 1600

export class VoiceTile implements Tile {
  private readonly model: ControlModel
  private readonly toggle: Binding
  private host: TileHost | null = null
  private unsubscribe: Unsubscribe | null = null
  private ripple: NodeJS.Timeout | null = null

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
    this.ripple = setInterval(() => this.host?.invalidate(), FRAME_MILLISECONDS)
    // An animation must not keep the daemon alive on shutdown.
    this.ripple.unref()
  }

  private stopRipple(): void {
    if (this.ripple) clearInterval(this.ripple)
    this.ripple = null
  }

  render({ state, now }: TileContext): Bitmap {
    const running = isAssistRunning(state)
    const face = labelTile(running ? '#006064' : '#00272b', running ? 'CANCEL' : 'VOICE')
    if (running) {
      // Two rings a half-cycle apart, each fading as it grows, so the sweep
      // reads as continuous rather than restarting.
      const phase = (now % RIPPLE_PERIOD_MILLISECONDS) / RIPPLE_PERIOD_MILLISECONDS
      for (const offset of [0, 0.5]) {
        const step = (phase + offset) % 1
        drawCircle(face, 60, 46, 20 + Math.round(step * 26), step > 0.6 ? '#00838f' : '#00e5ff', {
          thickness: 3,
        })
      }
    }
    micIcon(face, 60, 44, running ? '#ffffff' : '#4dd0e1')
    return face
  }
}
