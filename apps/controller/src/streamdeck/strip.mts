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

import {DialScreen} from './screens/dial-screen.mjs'
import {NotificationScreen} from './screens/notification-screen.mjs'
import type {Screen, ScreenHost} from './screens/screen.mjs'
import type {Surface} from './surface.mjs'
import type {Dial} from './dial.mjs'
import type {Notification, NotificationFeed} from '../types.mjs'

/** How long the strip keeps showing a dial after it was last moved. */
export const DIAL_HOLD_MILLISECONDS = 2500

/** The physical strip is divided into one press zone per dial. */
const ZONE_WIDTH = 200

export interface TouchStripOptions {
    /**
     * What the strip shows when nothing else is claiming it, in priority order:
     * the strip shows the first whose `applies()` returns true, falling back to
     * the last (a catch-all, usually with no `applies`). The now-playing face,
     * then the idle clock.
     */
    resting: readonly Screen[]
    /** The layout's dials, so a press on the strip runs the dial beneath it. */
    dials: readonly Dial[]
    /** Messages pushed from Home Assistant; omitted when nothing can push any. */
    notifications?: NotificationFeed
    dialHoldMilliseconds?: number
    /** Wall-clock milliseconds, injected so a test can pin the dial hold and drain. */
    clock?: () => number
}

export class TouchStrip {
    readonly #resting: readonly Screen[]
    readonly #dials: readonly Dial[]
    readonly #notifications: NotificationFeed | undefined
    readonly #dialHoldMilliseconds: number
    readonly #clock: () => number
    readonly #dialScreen: DialScreen
    readonly #notificationScreen: NotificationScreen
    #host: ScreenHost | null = null
    // Which dial is being shown, and until when. Held as an instant rather than a
    // countdown so what is showing stays a pure function of the clock.
    #dialIndex = -1
    #dialUntil = 0
    #frames: NodeJS.Timeout | null = null
    #frameRate = 0
    #wake: NodeJS.Timeout | null = null

    constructor({
                    resting,
                    dials,
                    notifications,
                    dialHoldMilliseconds = DIAL_HOLD_MILLISECONDS,
                    clock = Date.now,
                }: TouchStripOptions) {
        this.#resting = resting
        this.#dials = dials
        this.#notifications = notifications
        this.#dialHoldMilliseconds = dialHoldMilliseconds
        this.#clock = clock
        this.#dialScreen = new DialScreen(clock)
        this.#notificationScreen = new NotificationScreen(clock)
    }

    /** Every screen the strip can show, in no particular order. */
    get #screens(): Screen[] {
        return [...this.#resting, this.#dialScreen, this.#notificationScreen]
    }

    /**
     * The resting face for right now: the first candidate that applies, or the
     * last as a catch-all. All the candidates stay mounted, so the one not
     * showing keeps watching its entity and repaints the strip when the pick
     * should change (a track starting or stopping).
     */
    #restingScreen(): Screen {
        const chosen = this.#resting.find((screen) => screen.applies?.() ?? true)
        return chosen ?? this.#resting[this.#resting.length - 1] ?? this.#dialScreen
    }

    /** Called when the strip is live on an attached deck. */
    mount(host: ScreenHost): void {
        // Only tear down a strip that is actually up: a first mount must not send
        // `unmount` to screens that were never mounted.
        if (this.#host) this.unmount()
        this.#host = host
        for (const screen of this.#screens) screen.mount?.({invalidate: () => host.invalidate()})
    }

    unmount(): void {
        for (const screen of this.#screens) screen.unmount?.()
        this.#stopFrames()
        this.#stopWake()
        this.#host = null
    }

    /**
     * Report a dial being turned or pressed, so the strip shows that dial's
     * readout. Called for every rotation step; extending the hold from the last
     * one is what keeps the readout up while a knob is still moving.
     */
    showDial(index: number, now = this.#clock()): void {
        if (index < 0 || index >= this.#dials.length) return
        this.#dialIndex = index
        this.#dialUntil = now + this.#dialHoldMilliseconds
        this.#host?.invalidate()
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
    pressAt(x: number, now = this.#clock()): (() => unknown) | undefined {
        if (this.#showingNotification(now)) {
            this.#notifications?.dismiss()
            this.#host?.invalidate()
            return undefined
        }
        // While the resting face is the one up, its own controls (the now-playing
        // play/pause and shuffle buttons) claim the tap before the dial beneath
        // them does; a tap that misses them falls through to the dial zone.
        if (!this.#pinnedDial() && now >= this.#dialUntil) {
            const hit = this.#restingScreen().pressAt?.(x)
            if (hit) return hit
        }
        const index = Math.max(0, Math.min(this.#dials.length - 1, Math.floor(x / ZONE_WIDTH)))
        this.showDial(index, now)
        const press = this.#dials[index]?.press
        return press ? () => press.run() : undefined
    }

    /** Paint the face for the current state, and arm the timers that go with it. */
    draw(surface: Surface, deltaTime: number): void {
        const now = this.#clock()
        // A dial that pins itself (a mid-pick claim) holds the strip until it
        // releases, so the choice stays up for the whole claim; otherwise the strip
        // shows the dial being turned for its short after-turn hold.
        const pinned = this.#pinnedDial()
        const held = now < this.#dialUntil ? this.#dials[this.#dialIndex] : undefined
        const dial = pinned ?? held
        // Nothing is asked of the queue while a dial is showing: a message's time
        // starts when it reaches the strip, so one that arrives mid-turn waits its
        // full length rather than expiring behind the readout.
        const notification = dial ? undefined : this.#notifications?.current(now)
        const screen = this.#select(dial, notification)
        screen.draw(surface, deltaTime)
        // Only the short hold needs a wake-up to fall back on expiry; a pinned dial
        // repaints when its claim releases (the model notifies), so arming a wake at
        // its already-passed hold would spin the strip at 16ms.
        if (this.#host) this.#arm(screen, pinned ? undefined : held)
    }

    /** The dial currently pinning the strip to its readout, if any. */
    #pinnedDial(): Dial | undefined {
        const index = this.#dials.findIndex((dial) => dial.pinned?.())
        return index >= 0 ? this.#dials[index] : undefined
    }

    /**
     * Pick the screen for the current subject and hand it that subject, so a
     * screen draws what the strip selected it for without reading a context.
     */
    #select(dial: Dial | undefined, notification: Notification | undefined): Screen {
        if (dial) {
            this.#dialScreen.show(dial)
            return this.#dialScreen
        }
        if (notification) {
            this.#notificationScreen.show(notification)
            return this.#notificationScreen
        }
        return this.#restingScreen()
    }

    #showingNotification(now: number): boolean {
        // A pinned dial is over the strip, so a tap belongs to it, not to a
        // notification waiting behind it.
        if (this.#pinnedDial()) return false
        return now >= this.#dialUntil && this.#notifications?.current(now) !== undefined
    }

    /**
     * Keep the frame timer matching what is showing, and set one wake-up for the
     * moment the dial readout stops being current — without it the strip would
     * keep the readout up until something else happened to repaint it.
     */
    #arm(screen: Screen, dial: Dial | undefined): void {
        const rate = screen.animationMilliseconds?.()
        if (rate !== this.#frameRate) {
            this.#stopFrames()
            this.#frameRate = rate ?? 0
            if (rate) {
                this.#frames = setInterval(() => this.#host?.invalidate(), rate)
                // Strip repaints must not keep the daemon alive on shutdown.
                this.#frames.unref()
            }
        }

        this.#stopWake()
        if (dial) {
            this.#wake = setTimeout(() => this.#host?.invalidate(), Math.max(16, this.#dialUntil - this.#clock()))
            this.#wake.unref()
        }
    }

    #stopFrames(): void {
        if (this.#frames) clearInterval(this.#frames)
        this.#frames = null
        this.#frameRate = 0
    }

    #stopWake(): void {
        if (this.#wake) clearTimeout(this.#wake)
        this.#wake = null
    }
}
