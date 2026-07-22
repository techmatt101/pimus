// The push channel from Home Assistant to the touch strip: an automation fires
// an event and the deck shows it. This is the one thing the controller learns
// from Home Assistant that is not an entity — "someone is at the door" and "the
// washing machine has finished" are moments, not states, and giving each of them
// a helper entity to watch would be a helper per message.
//
// An automation reaches the deck with nothing more than:
//
//     action:
//       - event: smartamp_notify
//         event_data:
//           title: FRONT DOOR
//           message: SOMEONE IS AT THE DOOR
//           color: '#b71c1c'
//           seconds: 10
//
// Messages queue rather than overwrite: a doorbell that arrives while the
// washing machine banner is up gets its own time on the strip instead of
// replacing it mid-read. Expiry is measured from when a message first became
// visible, not from when it arrived, so nothing is shown for less than its time.

import type { HomeAssistantService, Notification, NotificationFeed } from '../types.mjs'

/** The Home Assistant event type automations fire to reach the strip. */
export const NOTIFY_EVENT = 'smartamp_notify'

/** How long a message stays up when the automation does not say. */
const DEFAULT_SECONDS = 8
/** A ceiling, so a typo cannot park a banner over the strip indefinitely. */
const MAX_SECONDS = 120
const DEFAULT_COLOR = '#4527a0'
/** Depth cap: an automation loop must not grow this without bound. */
const MAX_QUEUED = 8
/** Long enough to read on a 800x100 strip; the rest is dropped. */
const MAX_MESSAGE = 120

/** A message that has arrived but not yet had its turn on the strip. */
interface PendingNotification {
  title: string
  message: string
  color: string
  milliseconds: number
}

export interface NotificationCenterOptions {
  ha: HomeAssistantService
  /** The event type to listen for; the default is what docs/controls.md documents. */
  eventType?: string
  /** Called when a message arrives, so the deck repaints without waiting. */
  onChange?: () => void
  logger?: Pick<Console, 'log'>
}

/**
 * The queue of notifications waiting for the strip. It owns the Home Assistant
 * subscription and the display timing; what a banner looks like belongs to
 * streamdeck/screens/notification-screen.mts.
 */
export class NotificationCenter implements NotificationFeed {
  private readonly ha: HomeAssistantService
  private readonly eventType: string
  private readonly onChange: () => void
  private readonly logger: Pick<Console, 'log'>
  private readonly pending: PendingNotification[] = []
  private showing: Notification | null = null
  private unlisten: (() => void) | null = null

  constructor({
    ha,
    eventType = NOTIFY_EVENT,
    onChange = () => {},
    logger = console,
  }: NotificationCenterOptions) {
    this.ha = ha
    this.eventType = eventType
    this.onChange = onChange
    this.logger = logger
  }

  /** Begin listening. Safe to call once; index.mts does it at startup. */
  start(): void {
    if (this.unlisten) return
    this.unlisten = this.ha.listen(this.eventType, (data) => this.post(data))
  }

  stop(): void {
    this.unlisten?.()
    this.unlisten = null
  }

  /**
   * Accept one event payload. Everything is optional except some text to show:
   * an automation that fires the event with no data at all is a mistake worth
   * logging rather than a blank banner nobody can explain.
   */
  post(data: Record<string, unknown>): void {
    const message = text(data.message) || text(data.title)
    if (!message) {
      this.logger.log(`${this.eventType} carried no message; ignored`)
      return
    }
    if (this.pending.length >= MAX_QUEUED) {
      this.logger.log(`${this.eventType} queue is full; dropped "${message}"`)
      return
    }
    const seconds = Number(data.seconds)
    this.pending.push({
      // With only one of the two given, that text is the message and the banner
      // simply has no heading.
      title: text(data.message) ? text(data.title) : '',
      message: message.slice(0, MAX_MESSAGE),
      color: text(data.color) || DEFAULT_COLOR,
      milliseconds: (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_SECONDS) : DEFAULT_SECONDS) * 1000,
    })
    this.onChange()
  }

  /**
   * What to show at `now`. Retiring an expired banner and starting the next
   * one's clock happen here rather than on a timer: the strip asks on every
   * repaint, and a clock that starts when a message becomes visible is the only
   * one that cannot expire while something else is being read.
   */
  current(now: number): Notification | undefined {
    if (this.showing && now >= this.showing.expiresAt) this.showing = null
    if (!this.showing) {
      const next = this.pending.shift()
      if (next) {
        this.showing = {
          title: next.title,
          message: next.message,
          color: next.color,
          shownAt: now,
          expiresAt: now + next.milliseconds,
        }
      }
    }
    return this.showing ?? undefined
  }

  /** Acknowledge the showing banner. Anything queued behind it still gets its turn. */
  dismiss(): void {
    if (!this.showing) return
    this.showing = null
    this.onChange()
  }
}

/** A trimmed string from an event field, or '' for anything unusable. */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}
