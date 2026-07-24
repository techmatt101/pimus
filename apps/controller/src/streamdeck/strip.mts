// The Stream Deck+ touch strip, as one 800x100 display rather than four dial
// labels. It owns which screen (streamdeck/screens/) is showing and when the
// strip goes back to resting:
//
//   1. a dial being turned or pressed, for a couple of seconds after the last
//      movement — the hand on the knob wins, even over a live notification,
//      because feedback you cannot see while turning is no feedback;
//   2. a notification pushed from Home Assistant, until its time is up or the
//      strip is tapped to acknowledge it;
//   3. otherwise the resting screen: what is playing.
//
// It runs the strip's repaints the same way an animated tile runs its key's: a
// frame timer while the visible screen asks for one, and a single wake-up when
// the dial readout is due to expire. Both are dropped on unmount, so a
// disconnected deck leaves no timers behind.
//
// A screen no longer reads which dial or notification it is being drawn for
// from a context: the strip works that out from its own clock and hands it to
// the chosen screen (`show`) before drawing it.

import { DialScreen } from './screens/dial-screen.mjs'
import { NotificationScreen } from './screens/notification-screen.mjs'
import type { Screen, ScreenHost } from './screens/screen.mjs'
import type { Surface } from './surface.mjs'
import type { Dial } from './dials/dial.mjs'
import type { Notification, NotificationFeed } from '../types.mjs'

/** How long the strip keeps showing a dial after it was last moved. */
export const DIAL_HOLD_MILLISECONDS = 2500

/** The physical strip is divided into one press zone per dial. */
const ZONE_WIDTH = 200

export interface TouchStripOptions {
  /** What the strip shows when nothing else is claiming it. */
  resting: Screen
  /** The layout's dials, so a press on the strip runs the dial beneath it. */
  dials: readonly Dial[]
  /** Messages pushed from Home Assistant; omitted when nothing can push any. */
  notifications?: NotificationFeed
  dialHoldMilliseconds?: number
  /** Wall-clock milliseconds, injected so a test can pin the dial hold and drain. */
  clock?: () => number
}

export class TouchStrip {
  private readonly resting: Screen
  private readonly dials: readonly Dial[]
  private readonly notifications: NotificationFeed | undefined
  private readonly dialHoldMilliseconds: number
  private readonly clock: () => number
  private readonly dialScreen: DialScreen
  private readonly notificationScreen: NotificationScreen
  private host: ScreenHost | null = null
  // Which dial is being shown, and until when. Held as an instant rather than a
  // countdown so what is showing stays a pure function of the clock.
  private dialIndex = -1
  private dialUntil = 0
  private frames: NodeJS.Timeout | null = null
  private frameRate = 0
  private wake: NodeJS.Timeout | null = null

  constructor({
    resting,
    dials,
    notifications,
    dialHoldMilliseconds = DIAL_HOLD_MILLISECONDS,
    clock = Date.now,
  }: TouchStripOptions) {
    this.resting = resting
    this.dials = dials
    this.notifications = notifications
    this.dialHoldMilliseconds = dialHoldMilliseconds
    this.clock = clock
    this.dialScreen = new DialScreen(clock)
    this.notificationScreen = new NotificationScreen(clock)
  }

  /** Every screen the strip can show, in no particular order. */
  private get screens(): Screen[] {
    return [this.resting, this.dialScreen, this.notificationScreen]
  }

  /** Called when the strip is live on an attached deck. */
  mount(host: ScreenHost): void {
    // Only tear down a strip that is actually up: a first mount must not send
    // `unmount` to screens that were never mounted.
    if (this.host) this.unmount()
    this.host = host
    for (const screen of this.screens) screen.mount?.({ invalidate: () => host.invalidate() })
  }

  unmount(): void {
    for (const screen of this.screens) screen.unmount?.()
    this.stopFrames()
    this.stopWake()
    this.host = null
  }

  /**
   * Report a dial being turned or pressed, so the strip shows that dial's
   * readout. Called for every rotation step; extending the hold from the last
   * one is what keeps the readout up while a knob is still moving.
   */
  showDial(index: number, now = this.clock()): void {
    if (index < 0 || index >= this.dials.length) return
    this.dialIndex = index
    this.dialUntil = now + this.dialHoldMilliseconds
    this.host?.invalidate()
  }

  /**
   * A press on the strip. While a notification is showing, the tap
   * acknowledges it and runs nothing else — the banner is over the dial labels,
   * so pressing what you can see is what should happen. Otherwise the press
   * belongs to the dial in that zone, exactly as pressing the dial itself does.
   *
   * Returns a thunk rather than acting, so the deck's dispatch queue keeps
   * presses in physical order.
   */
  pressAt(x: number, now = this.clock()): (() => unknown) | undefined {
    if (this.showingNotification(now)) {
      this.notifications?.dismiss()
      this.host?.invalidate()
      return undefined
    }
    const index = Math.max(0, Math.min(this.dials.length - 1, Math.floor(x / ZONE_WIDTH)))
    this.showDial(index, now)
    const press = this.dials[index]?.press
    return press ? () => press.run() : undefined
  }

  /** Paint the face for the current state, and arm the timers that go with it. */
  draw(surface: Surface, deltaTime: number): void {
    const now = this.clock()
    const dial = now < this.dialUntil ? this.dials[this.dialIndex] : undefined
    // Nothing is asked of the queue while a dial is showing: a message's time
    // starts when it reaches the strip, so one that arrives mid-turn waits its
    // full length rather than expiring behind the readout.
    const notification = dial ? undefined : this.notifications?.current(now)
    const screen = this.select(dial, notification)
    screen.draw(surface, deltaTime)
    if (this.host) this.arm(screen, dial)
  }

  /**
   * Pick the screen for the current subject and hand it that subject, so a
   * screen draws what the strip selected it for without reading a context.
   */
  private select(dial: Dial | undefined, notification: Notification | undefined): Screen {
    if (dial) {
      this.dialScreen.show(dial)
      return this.dialScreen
    }
    if (notification) {
      this.notificationScreen.show(notification)
      return this.notificationScreen
    }
    return this.resting
  }

  private showingNotification(now: number): boolean {
    return now >= this.dialUntil && this.notifications?.current(now) !== undefined
  }

  /**
   * Keep the frame timer matching what is showing, and set one wake-up for the
   * moment the dial readout stops being current — without it the strip would
   * keep the readout up until something else happened to repaint it.
   */
  private arm(screen: Screen, dial: Dial | undefined): void {
    const rate = screen.animationMilliseconds?.()
    if (rate !== this.frameRate) {
      this.stopFrames()
      this.frameRate = rate ?? 0
      if (rate) {
        this.frames = setInterval(() => this.host?.invalidate(), rate)
        // Strip repaints must not keep the daemon alive on shutdown.
        this.frames.unref()
      }
    }

    this.stopWake()
    if (dial) {
      this.wake = setTimeout(() => this.host?.invalidate(), Math.max(16, this.dialUntil - this.clock()))
      this.wake.unref()
    }
  }

  private stopFrames(): void {
    if (this.frames) clearInterval(this.frames)
    this.frames = null
    this.frameRate = 0
  }

  private stopWake(): void {
    if (this.wake) clearTimeout(this.wake)
    this.wake = null
  }
}
