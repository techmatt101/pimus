import {type ControlModel, LIVE_ASSIST_STATES, type Unsubscribe} from '../state.mjs'
import type {HomeAssistantService, PanelState} from '../types.mjs'

export const DEFAULT_STANDBY_MILLISECONDS = 3 * 60_000
export const DEFAULT_SLEEP_MILLISECONDS = 5 * 60_000

export interface SleepControllerOptions {
    model: ControlModel
    ha: HomeAssistantService
    /** Empty turns standby and sleep off entirely and the panel stays lit. */
    presenceEntity: string
    /** How long without a touch or a live pipeline before the panel dims. */
    standbyMilliseconds?: number
    /** How long the room must read empty before the panel switches off. */
    sleepMilliseconds?: number
}

/**
 * Standby dims the panel after a spell without interaction — music can still
 * be playing — and sleep switches it off once the room has read empty long
 * enough, or at once when forced from the POWER key or the power button.
 * Whoever watches `panel` acts on the same states: dim suspends the amp
 * bridges, off also cuts USB power. Only sleep needs the presence sensor, and
 * it fails open: an unreachable Home Assistant or an unknown reading means
 * the panel never switches off, though it still dims.
 */
export class SleepController {
    readonly #model: ControlModel
    readonly #ha: HomeAssistantService
    readonly #presenceEntity: string
    readonly #standbyMilliseconds: number
    readonly #sleepMilliseconds: number
    #interactedAt = 0
    #absentSince: number | null = null
    #present: boolean | null = null
    #forced = false
    #running = false
    #timer: NodeJS.Timeout | null = null
    readonly #subscriptions: Unsubscribe[] = []

    constructor({
        model,
        ha,
        presenceEntity,
        standbyMilliseconds = DEFAULT_STANDBY_MILLISECONDS,
        sleepMilliseconds = DEFAULT_SLEEP_MILLISECONDS,
    }: SleepControllerOptions) {
        this.#model = model
        this.#ha = ha
        this.#presenceEntity = presenceEntity
        this.#standbyMilliseconds = standbyMilliseconds
        this.#sleepMilliseconds = sleepMilliseconds
    }

    start(): void {
        if (!this.#presenceEntity) return
        this.#running = true
        this.#interactedAt = Date.now()
        this.#subscriptions.push(this.#ha.watch([this.#presenceEntity], () => this.#evaluate()))
        // Writing `panel` back into the model re-enters here; it terminates
        // because `evaluate` only notifies when the value actually changed.
        this.#subscriptions.push(this.#model.subscribe(() => this.#evaluate()))
        this.#evaluate()
    }

    stop(): void {
        this.#running = false
        for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe()
        this.#clearTimer()
    }

    /**
     * Report a key press, dial turn, or strip tap. Returns true when the input
     * was spent waking the panel, so the caller must not also run the key under
     * the finger. A dark or dimmed panel is one whose faces cannot be read at a
     * glance, so the first input only brings the light back and the second acts.
     */
    touch(now = Date.now()): boolean {
        const woke = this.#model.state.panel !== 'lit'
        this.#forced = false
        this.#interactedAt = now
        // A touch is proof the room is not empty, whatever the sensor says;
        // evaluate re-seeds the empty-room clock if it still reads off.
        this.#absentSince = null
        this.#evaluate(now)
        return woke
    }

    /** The POWER key's sleep choice: off at once, until presence returns or the button wakes it. */
    forceSleep(): void {
        if (!this.#running) return
        this.#forced = true
        this.#evaluate()
    }

    /** The Pi's power button: wakes a sleeping panel, and forces sleep otherwise. */
    pressPowerButton(now = Date.now()): void {
        if (!this.#running) return
        if (this.#model.state.panel === 'off') this.touch(now)
        else this.forceSleep()
    }

    #evaluate(now = Date.now()): void {
        const live = LIVE_ASSIST_STATES.has(this.#model.state.assist)
        if (live) this.#interactedAt = now
        this.#readPresence(now)
        const emptied =
            this.#absentSince !== null && now - this.#absentSince >= this.#sleepMilliseconds
        const sleeping = this.#forced || (emptied && !live)
        const panel: PanelState = sleeping
            ? 'off'
            : now - this.#interactedAt >= this.#standbyMilliseconds
                ? 'dim'
                : 'lit'
        this.#arm(now, sleeping)
        if (panel === this.#model.state.panel) return
        this.#model.state.panel = panel
        this.#model.notify()
    }

    #readPresence(now: number): void {
        const reading = this.#presenceReading()
        if (reading === null) {
            this.#absentSince = null
            this.#present = null
            return
        }
        if (reading) {
            // Walking back in is the arrival edge: it relights the panel and
            // releases a forced sleep, so the room is ready before anything
            // is pressed or said.
            if (this.#present === false) {
                this.#forced = false
                this.#interactedAt = now
            }
            this.#absentSince = null
        } else {
            this.#absentSince ??= now
        }
        this.#present = reading
    }

    #presenceReading(): boolean | null {
        if (!this.#ha.connected) return null
        const presence = this.#ha.entity(this.#presenceEntity)?.state
        if (presence === 'on') return true
        if (presence === 'off') return false
        return null
    }

    #arm(now: number, sleeping: boolean): void {
        this.#clearTimer()
        if (sleeping) return
        const deadlines: number[] = []
        const dimAt = this.#interactedAt + this.#standbyMilliseconds
        if (dimAt > now) deadlines.push(dimAt)
        if (this.#absentSince !== null) {
            const sleepAt = this.#absentSince + this.#sleepMilliseconds
            if (sleepAt > now) deadlines.push(sleepAt)
        }
        if (deadlines.length === 0) return
        this.#timer = setTimeout(() => {
            this.#timer = null
            this.#evaluate()
        }, Math.min(...deadlines) - now)
        this.#timer.unref()
    }

    #clearTimer(): void {
        if (!this.#timer) return
        clearTimeout(this.#timer)
        this.#timer = null
    }
}
