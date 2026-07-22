// When the Stream Deck's panel switches itself off. A lit deck in an empty
// office is the whole of the problem: nothing else about the endpoint sleeps,
// so the wake word, the ReSpeaker ring, and background playback are untouched.
//
// The decision lives here rather than in the renderer because it is a policy
// about the room, not about drawing. It writes one field — `state.awake` — and
// the renderer reacts to it exactly as it reacts to a deck being unplugged
// (streamdeck/renderer.mts): unmount the tiles, drop their timers, panel dark.
//
// Three things keep the panel lit, and each of them restarts the grace period
// rather than pinning it awake, so leaving the room always ends the same way:
//
//   1. the presence sensor reading `on`;
//   2. a live Assist pipeline — wake word, listening, speaking, a ringing
//      timer — because what it is doing has to be visible;
//   3. a hand on the deck (`touch()`), which is the safety net for a presence
//      sensor that is simply wrong.
//
// It fails open in every direction. An unreachable Home Assistant, a sensor
// that has never reported, one reporting `unavailable`, or no configured entity
// at all all mean "stay awake": a dark panel you cannot explain is far worse
// than a lit one you did not need.

import { LIVE_ASSIST_STATES, type ControlModel, type Unsubscribe } from '../state.mjs'
import type { HomeAssistantService } from '../types.mjs'

/** How long the panel stays lit after the last reason to be lit went away. */
export const DEFAULT_GRACE_MILLISECONDS = 2 * 60_000

export interface SleepControllerOptions {
  model: ControlModel
  ha: HomeAssistantService
  /**
   * The `binary_sensor` that reads `on` while somebody is in the room. Empty
   * turns sleeping off entirely and the panel stays lit.
   */
  presenceEntity: string
  graceMilliseconds?: number
}

export class SleepController {
  private readonly model: ControlModel
  private readonly ha: HomeAssistantService
  private readonly presenceEntity: string
  private readonly graceMilliseconds: number
  // The grace period, held as the instant it ends rather than as a countdown,
  // the same shape the touch strip holds a dial readout with. Only meaningful
  // while nothing is holding the panel awake.
  private awakeUntil = 0
  // Whether something was holding the panel awake at the last evaluation. The
  // countdown is started by this going false, so a room occupied all afternoon
  // still gets its full grace period when you finally leave it.
  private keeping = true
  private timer: NodeJS.Timeout | null = null
  private readonly subscriptions: Unsubscribe[] = []

  constructor({ model, ha, presenceEntity, graceMilliseconds = DEFAULT_GRACE_MILLISECONDS }: SleepControllerOptions) {
    this.model = model
    this.ha = ha
    this.presenceEntity = presenceEntity
    this.graceMilliseconds = graceMilliseconds
  }

  /**
   * Start watching. With no presence entity configured nothing is watched and
   * the panel is never put to sleep, which is also what an LED-only deployment
   * and a controller with no Home Assistant get.
   */
  start(): void {
    if (!this.presenceEntity) return
    this.subscriptions.push(this.ha.watch([this.presenceEntity], () => this.evaluate()))
    // The model tells us about the voice pipeline. Writing `awake` back into it
    // re-enters here, which terminates because `evaluate` only notifies when the
    // value actually changed.
    this.subscriptions.push(this.model.subscribe(() => this.evaluate()))
    this.evaluate()
  }

  stop(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.clearTimer()
  }

  /**
   * Report a key press, a dial turn, or a tap on the strip. Returns true when
   * the input was spent waking the panel, so the caller must not also run the
   * key under your finger: the first press on a dark deck is you asking to see
   * it, not asking to toggle a light you cannot currently read.
   */
  touch(now = Date.now()): boolean {
    const woke = !this.model.state.awake
    this.awakeUntil = Math.max(this.awakeUntil, now + this.graceMilliseconds)
    this.evaluate(now)
    return woke
  }

  /** Recompute whether the panel should be lit, and publish any change. */
  private evaluate(now = Date.now()): void {
    const keep = this.keepAwake()
    if (this.keeping && !keep) this.awakeUntil = now + this.graceMilliseconds
    this.keeping = keep
    const awake = keep || now < this.awakeUntil
    this.arm(keep ? 0 : this.awakeUntil - now)
    if (awake === this.model.state.awake) return
    this.model.state.awake = awake
    this.model.notify()
  }

  /** Whether something right now demands a lit panel. */
  private keepAwake(): boolean {
    // Fail open: no connection means no opinion, and no opinion means lit.
    if (!this.ha.connected) return true
    const presence = this.ha.entity(this.presenceEntity)?.state
    if (presence === undefined || presence === 'unknown' || presence === 'unavailable') return true
    if (presence === 'on') return true
    return LIVE_ASSIST_STATES.has(this.model.state.assist)
  }

  /**
   * One wake-up at the moment the grace period runs out, and none at all while
   * a reason to be lit holds. Nothing polls: every other transition arrives as
   * a watcher callback.
   */
  private arm(remaining: number): void {
    this.clearTimer()
    if (remaining <= 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.evaluate()
    }, remaining)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
