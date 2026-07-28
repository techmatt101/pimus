import {type ControlModel, LIVE_ASSIST_STATES, type Unsubscribe} from '../state.mjs'
import type {HomeAssistantService, PanelState} from '../types.mjs'

export const DEFAULT_GRACE_MILLISECONDS = 2 * 60_000
export const DEFAULT_DIM_MILLISECONDS = 5_000

export interface SleepControllerOptions {
    model: ControlModel
    ha: HomeAssistantService
    /** Empty turns sleeping off entirely and the panel stays lit. */
    presenceEntity: string
    graceMilliseconds?: number
    /** How long the panel is dimmed as a warning before it goes dark. */
    dimMilliseconds?: number
}

/**
 * Dims the deck's panel when the room empties and switches it off shortly
 * after. Only the panel sleeps — the wake word, LED ring, and playback are
 * untouched. Fails open: an unreachable Home Assistant or an unknown presence
 * sensor means stay lit.
 */
export class SleepController {
    readonly #model: ControlModel
    readonly #ha: HomeAssistantService
    readonly #presenceEntity: string
    readonly #graceMilliseconds: number
    readonly #dimMilliseconds: number
    #awakeUntil = 0
    // The countdown starts when this goes false, so a room occupied all
    // afternoon still gets its full grace period when you finally leave.
    #keeping = true
    #timer: NodeJS.Timeout | null = null
    readonly #subscriptions: Unsubscribe[] = []

    constructor({
        model,
        ha,
        presenceEntity,
        graceMilliseconds = DEFAULT_GRACE_MILLISECONDS,
        dimMilliseconds = DEFAULT_DIM_MILLISECONDS,
    }: SleepControllerOptions) {
        this.#model = model
        this.#ha = ha
        this.#presenceEntity = presenceEntity
        this.#graceMilliseconds = graceMilliseconds
        this.#dimMilliseconds = dimMilliseconds
    }

    start(): void {
        if (!this.#presenceEntity) return
        this.#subscriptions.push(this.#ha.watch([this.#presenceEntity], () => this.#evaluate()))
        // Writing `panel` back into the model re-enters here; it terminates
        // because `evaluate` only notifies when the value actually changed.
        this.#subscriptions.push(this.#model.subscribe(() => this.#evaluate()))
        this.#evaluate()
    }

    stop(): void {
        for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe()
        this.#clearTimer()
    }

    /**
     * Report a key press, dial turn, or strip tap. Returns true when the input
     * was spent waking the panel, so the caller must not also run the key under
     * the finger. A dimmed panel is still readable, so its keys run as normal
     * and the press simply brings the light back.
     */
    touch(now = Date.now()): boolean {
        const woke = this.#model.state.panel === 'off'
        this.#awakeUntil = Math.max(this.#awakeUntil, now + this.#graceMilliseconds)
        this.#evaluate(now)
        return woke
    }

    #evaluate(now = Date.now()): void {
        const keep = this.#keepAwake()
        if (this.#keeping && !keep) this.#awakeUntil = now + this.#graceMilliseconds
        this.#keeping = keep
        const panel = keep ? 'lit' : this.#panelAt(now)
        this.#arm(keep ? 0 : this.#nextChangeIn(now, panel))
        if (panel === this.#model.state.panel) return
        this.#model.state.panel = panel
        this.#model.notify()
    }

    #panelAt(now: number): PanelState {
        if (now < this.#awakeUntil) return 'lit'
        if (now < this.#awakeUntil + this.#dimMilliseconds) return 'dim'
        return 'off'
    }

    #nextChangeIn(now: number, panel: PanelState): number {
        if (panel === 'lit') return this.#awakeUntil - now
        if (panel === 'dim') return this.#awakeUntil + this.#dimMilliseconds - now
        return 0
    }

    #keepAwake(): boolean {
        if (!this.#ha.connected) return true
        const presence = this.#ha.entity(this.#presenceEntity)?.state
        if (presence === undefined || presence === 'unknown' || presence === 'unavailable') return true
        if (presence === 'on') return true
        return LIVE_ASSIST_STATES.has(this.#model.state.assist)
    }

    #arm(remaining: number): void {
        this.#clearTimer()
        if (remaining <= 0) return
        this.#timer = setTimeout(() => {
            this.#timer = null
            this.#evaluate()
        }, remaining)
        this.#timer.unref()
    }

    #clearTimer(): void {
        if (!this.#timer) return
        clearTimeout(this.#timer)
        this.#timer = null
    }
}
