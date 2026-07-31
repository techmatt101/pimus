import {DialScreen} from './screens/dial-screen.mjs'
import {NotificationScreen} from './screens/notification-screen.mjs'
import {minuteTick, type Screen, type ScreenHost} from './screens/screen.mjs'
import type {Surface} from './surface.mjs'
import type {Dial} from './dial.mjs'
import type {Notification, NotificationFeed} from '../types.mjs'

export const DIAL_HOLD_MILLISECONDS = 2500

const ZONE_WIDTH = 200

export interface TouchStripOptions {
    /** Candidate resting screens in priority order; the first whose `applies()` returns true shows. */
    resting: readonly Screen[]
    dials: readonly Dial[]
    notifications?: NotificationFeed
    dialHoldMilliseconds?: number
    clock?: () => number
}

/**
 * The strip shows one screen at a time: the dial being turned (for a short hold
 * after the last movement), then a live notification, then the resting face.
 */
export class TouchStrip {
    readonly #resting: readonly Screen[]
    readonly #dials: readonly Dial[]
    readonly #notifications: NotificationFeed | undefined
    readonly #dialHoldMilliseconds: number
    readonly #clock: () => number
    readonly #dialScreen: DialScreen
    readonly #notificationScreen: NotificationScreen
    #host: ScreenHost | null = null
    #preferred: Screen | null = null
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
        this.#dialScreen = new DialScreen()
        this.#notificationScreen = new NotificationScreen(clock)
    }

    get #screens(): Screen[] {
        return [...this.#resting, this.#dialScreen, this.#notificationScreen]
    }

    // All candidates stay mounted, so the one not showing keeps watching its
    // entity and repaints the strip when the pick should change.
    #restingScreen(): Screen {
        const candidates = this.#resting.filter((screen) => screen.applies?.() ?? true)
        // A choice only means something while there is something else to show,
        // so it lapses rather than outliving the face it was made against.
        if (this.#preferred && (candidates.length < 2 || !candidates.includes(this.#preferred))) this.#preferred = null
        return this.#preferred ?? candidates[0] ?? this.#resting[this.#resting.length - 1] ?? this.#dialScreen
    }

    /** Rest on `screen` in place of the highest-priority candidate that applies. */
    showResting(screen: Screen): void {
        if (!this.#resting.includes(screen)) return
        this.#preferred = screen
        this.#host?.invalidate()
    }

    mount(host: ScreenHost): void {
        if (this.#host) this.unmount()
        this.#host = host
        for (const screen of this.#screens) {
            screen.mount?.({invalidate: () => host.invalidate(), animating: () => host.animating()})
        }
    }

    unmount(): void {
        for (const screen of this.#screens) screen.unmount?.()
        this.#stopFrames()
        this.#stopWake()
        this.#host = null
    }

    /** Called for every rotation step; each call extends the hold. */
    showDial(index: number, now = this.#clock()): void {
        if (index < 0 || index >= this.#dials.length) return
        if (this.#dials[index]?.silent) return
        this.#dialIndex = index
        this.#dialUntil = now + this.#dialHoldMilliseconds
        this.#host?.invalidate()
    }

    // Returns a thunk rather than acting, so the deck's dispatch queue keeps
    // presses in physical order. Undefined means the press was consumed (a
    // notification acknowledged) or landed on an unbound dial.
    pressAt(x: number, now = this.#clock()): (() => unknown) | undefined {
        if (this.#showingNotification(now)) {
            this.#notifications?.dismiss()
            this.#host?.invalidate()
            return undefined
        }
        const pinned = this.#pinnedDial()
        // The resting screen's own controls claim the tap before the dial beneath.
        if (!pinned && now >= this.#dialUntil) {
            const hit = this.#restingScreen().pressAt?.(x)
            if (hit) return hit
        }
        const index = Math.max(0, Math.min(this.#dials.length - 1, Math.floor(x / ZONE_WIDTH)))
        // A tap on any zone but the armed dial's is spent cancelling its claim.
        if (pinned && this.#dials[index] !== pinned) {
            pinned.autoRelease?.()
            return undefined
        }
        this.showDial(index, now)
        const press = this.#dials[index]?.press
        return press ? () => press.run() : undefined
    }

    draw(surface: Surface, deltaTime: number): void {
        const now = this.#clock()
        const pinned = this.#pinnedDial()
        const held = now < this.#dialUntil ? this.#dials[this.#dialIndex] : undefined
        const dial = pinned ?? held
        // The queue is not consulted while a dial shows: a notification's time
        // starts when it reaches the strip, so one arriving mid-turn waits its
        // full length rather than expiring behind the readout.
        const notification = dial ? undefined : this.#notifications?.current(now)
        const screen = this.#select(dial, notification)
        screen.draw(surface, deltaTime)
        // Only the short hold gets a wake-up: a pinned dial repaints when its
        // claim releases, and arming a wake at its already-passed hold would spin
        // the strip at 16ms.
        if (this.#host) this.#arm(screen, pinned ? undefined : held)
    }

    #pinnedDial(): Dial | undefined {
        const index = this.#dials.findIndex((dial) => dial.pinned?.())
        return index >= 0 ? this.#dials[index] : undefined
    }

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
        if (this.#pinnedDial()) return false
        return now >= this.#dialUntil && this.#notifications?.current(now) !== undefined
    }

    #arm(screen: Screen, dial: Dial | undefined): void {
        // A dimmed panel animates nothing, but its clock still has to be honest,
        // so the frame timer drops to the minute rather than stopping outright.
        const animating = this.#host?.animating() ?? true
        const rate = animating ? screen.animationMilliseconds?.() : minuteTick(this.#clock())
        if (rate !== this.#frameRate) {
            this.#stopFrames()
            this.#frameRate = rate ?? 0
            if (rate) {
                this.#frames = setInterval(() => this.#host?.invalidate(), rate)
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
