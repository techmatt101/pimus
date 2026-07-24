// An automation reaches the strip with:
//
//     action:
//       - event: smartamp_notify
//         event_data:
//           title: FRONT DOOR
//           message: SOMEONE IS AT THE DOOR
//           color: '#b71c1c'
//           seconds: 10

import type {HomeAssistantService, Notification, NotificationFeed} from '../types.mjs'

export const NOTIFY_EVENT = 'smartamp_notify'

const DEFAULT_SECONDS = 8
const MAX_SECONDS = 120
const DEFAULT_COLOR = '#4527a0'
const MAX_QUEUED = 8
const MAX_MESSAGE = 120

interface PendingNotification {
    title: string
    message: string
    color: string
    milliseconds: number
}

export interface NotificationCenterOptions {
    ha: HomeAssistantService
    eventType?: string
    /** Called when a message arrives, so the deck repaints without waiting. */
    onChange?: () => void
    logger?: Pick<Console, 'log'>
}

/**
 * The queue of notifications waiting for the strip. Messages queue rather than
 * overwrite, and expiry is measured from when a message first became visible,
 * so nothing is shown for less than its time.
 */
export class NotificationCenter implements NotificationFeed {
    readonly #ha: HomeAssistantService
    readonly #eventType: string
    readonly #onChange: () => void
    readonly #logger: Pick<Console, 'log'>
    readonly #pending: PendingNotification[] = []
    #showing: Notification | null = null
    #unlisten: (() => void) | null = null

    constructor({
                    ha,
                    eventType = NOTIFY_EVENT,
                    onChange = () => {
                    },
                    logger = console,
                }: NotificationCenterOptions) {
        this.#ha = ha
        this.#eventType = eventType
        this.#onChange = onChange
        this.#logger = logger
    }

    start(): void {
        if (this.#unlisten) return
        this.#unlisten = this.#ha.listen(this.#eventType, (data) => this.post(data))
    }

    stop(): void {
        this.#unlisten?.()
        this.#unlisten = null
    }

    post(data: Record<string, unknown>): void {
        const message = text(data.message) || text(data.title)
        if (!message) {
            this.#logger.log(`${this.#eventType} carried no message; ignored`)
            return
        }
        if (this.#pending.length >= MAX_QUEUED) {
            this.#logger.log(`${this.#eventType} queue is full; dropped "${message}"`)
            return
        }
        const seconds = Number(data.seconds)
        this.#pending.push({
            // With only one of title/message given, that text is the message and
            // the banner has no heading.
            title: text(data.message) ? text(data.title) : '',
            message: message.slice(0, MAX_MESSAGE),
            color: text(data.color) || DEFAULT_COLOR,
            milliseconds: (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_SECONDS) : DEFAULT_SECONDS) * 1000,
        })
        this.#onChange()
    }

    // Retiring an expired banner and starting the next one's clock happen here,
    // on repaint, rather than on a timer.
    current(now: number): Notification | undefined {
        if (this.#showing && now >= this.#showing.expiresAt) this.#showing = null
        if (!this.#showing) {
            const next = this.#pending.shift()
            if (next) {
                this.#showing = {
                    title: next.title,
                    message: next.message,
                    color: next.color,
                    shownAt: now,
                    expiresAt: now + next.milliseconds,
                }
            }
        }
        return this.#showing ?? undefined
    }

    dismiss(): void {
        if (!this.#showing) return
        this.#showing = null
        this.#onChange()
    }
}

function text(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}
