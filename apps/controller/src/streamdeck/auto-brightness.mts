import {numericState} from '../home-assistant/entity.mjs'
import type {ControlModel, Unsubscribe} from '../state.mjs'
import type {HomeAssistantService, PanelState} from '../types.mjs'

export const DEFAULT_SETTLE_MILLISECONDS = 60_000

/** The panel's own levels are coarse, so every reading lands on a 5% notch. */
const LEVEL_STEP = 5

export interface AutoBrightnessOptions {
    model: ControlModel
    ha: HomeAssistantService
    /** Empty leaves the panel on the brightness it starts with. */
    illuminanceEntity: string
    /** Panel percent in an unlit room. */
    minPercent?: number
    /** Panel percent once the room reaches `brightLux`. */
    maxPercent?: number
    brightLux?: number
    /** A change this big is the room's lights going on or off, and lands at once. */
    jumpPercent?: number
    /** The shortest spell between the smaller changes, which the sensor makes constantly. */
    settleMilliseconds?: number
    clock?: () => number
}

/**
 * Follows a Home Assistant illuminance sensor with the Stream Deck's panel
 * brightness. An office sensor moves all day and reports every step of it, so a
 * small change is rate-limited to one every `settleMilliseconds` while a jump —
 * the room's lights going on or off — lands immediately. A dark panel writes
 * nothing at all and takes the newest reading whole when it wakes, which is the
 * lights-on moment: both happen as somebody walks in.
 *
 * It fails towards leaving the panel be: an unreachable Home Assistant or a
 * sensor that has never reported means the brightness simply stops moving.
 */
export class AutoBrightness {
    readonly #model: ControlModel
    readonly #ha: HomeAssistantService
    readonly #entity: string
    readonly #minPercent: number
    readonly #maxPercent: number
    readonly #brightLux: number
    readonly #jumpPercent: number
    readonly #settleMilliseconds: number
    readonly #now: () => number
    readonly #subscriptions: Unsubscribe[] = []
    #target: number | null = null
    #appliedAt = 0
    #panel: PanelState = 'lit'
    #timer: NodeJS.Timeout | null = null

    constructor({
        model,
        ha,
        illuminanceEntity,
        minPercent = 15,
        maxPercent = 100,
        brightLux = 500,
        jumpPercent = 20,
        settleMilliseconds = DEFAULT_SETTLE_MILLISECONDS,
        clock = Date.now,
    }: AutoBrightnessOptions) {
        this.#model = model
        this.#ha = ha
        this.#entity = illuminanceEntity
        this.#minPercent = minPercent
        this.#maxPercent = maxPercent
        this.#brightLux = brightLux
        this.#jumpPercent = jumpPercent
        this.#settleMilliseconds = settleMilliseconds
        this.#now = clock
    }

    start(): void {
        if (!this.#entity) return
        this.#panel = this.#model.state.panel
        this.#subscriptions.push(this.#ha.watch([this.#entity], () => this.#read()))
        this.#subscriptions.push(this.#model.subscribe(() => this.#panelChanged()))
        this.#read(true)
    }

    stop(): void {
        for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe()
        this.#clearTimer()
    }

    #read(immediate = false): void {
        const lux = numericState(this.#ha.entity(this.#entity))
        if (lux === undefined) return
        this.#target = this.#levelFor(lux)
        this.#settle(immediate)
    }

    #panelChanged(): void {
        const panel = this.#model.state.panel
        if (panel === this.#panel) return
        const woke = this.#panel === 'off'
        this.#panel = panel
        if (woke) this.#read(true)
    }

    /**
     * The eye reads light logarithmically, so the notch between an unlit room
     * and a lamp is worth as much of the panel's range as the one between that
     * lamp and full daylight.
     */
    #levelFor(lux: number): number {
        const scale = Math.log10(Math.max(0, lux) + 1) / Math.log10(this.#brightLux + 1)
        const percent = this.#minPercent
            + (this.#maxPercent - this.#minPercent) * Math.min(1, Math.max(0, scale))
        return Math.round(percent / LEVEL_STEP) * LEVEL_STEP
    }

    #settle(immediate: boolean): void {
        this.#clearTimer()
        const target = this.#target
        if (target === null || this.#panel === 'off') return
        const delta = Math.abs(target - this.#model.state.brightness)
        if (delta === 0) return
        const wait = this.#settleMilliseconds - (this.#now() - this.#appliedAt)
        if (immediate || delta >= this.#jumpPercent || wait <= 0) return this.#apply(target)
        // Re-reading on the timer rather than writing this level then means a
        // burst of readings collapses into one write of the last of them.
        this.#timer = setTimeout(() => {
            this.#timer = null
            this.#settle(false)
        }, wait)
        this.#timer.unref()
    }

    #apply(target: number): void {
        this.#appliedAt = this.#now()
        this.#model.state.brightness = target
        this.#model.notify()
    }

    #clearTimer(): void {
        if (!this.#timer) return
        clearTimeout(this.#timer)
        this.#timer = null
    }
}
