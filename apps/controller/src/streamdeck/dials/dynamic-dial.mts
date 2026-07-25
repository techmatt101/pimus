import {entityDomain} from '../../actions/catalog.mjs'
import {isEntityOn, numericAttribute} from '../../home-assistant/entity.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {type Dial, fraction, percent} from '../dial.mjs'
import {EntityLevel, type LevelDomain} from './entity-level.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantService} from '../../types.mjs'

const IDLE_LABEL = 'CONTROL'
const IDLE_DETAIL = 'PICK A KEY'

export const CLAIM_TIMEOUT_MILLISECONDS = 15_000

// Home Assistant reports brightness on 0-255, position and fan speed as a
// percentage; every domain drives the dial in 0..1 and sets an absolute value.
const BRIGHTNESS_MAX = 255
const STEP = 0.1

interface DialDomain extends LevelDomain {
    /** Readout while on with no level to show, and while off. */
    on: string
    off: string
}

const DIAL_DOMAINS: Record<string, DialDomain> = {
    light: {
        read: (entity) => fraction(numericAttribute(entity, 'brightness'), BRIGHTNESS_MAX),
        step: () => STEP,
        optimistic: (level) => level > 0
            ? {state: 'on', attributes: {brightness: Math.round(level * BRIGHTNESS_MAX)}}
            : {state: 'off', attributes: {brightness: null}},
        apply: (ha, entity, level) => level > 0
            ? ha.call('light', 'turn_on', entity, {brightness_pct: Math.round(level * 100)})
            : ha.call('light', 'turn_off', entity),
        on: 'ON',
        off: 'OFF',
    },
    fan: {
        read: (entity) => fraction(numericAttribute(entity, 'percentage'), 100),
        // A fan steps by its own speed increment so a three-speed fan reaches
        // medium in one turn, not four; without one, fall back to a quarter.
        step: (entity) => (numericAttribute(entity, 'percentage_step') ?? 25) / 100,
        optimistic: (level) => level > 0
            ? {state: 'on', attributes: {percentage: Math.round(level * 100)}}
            : {state: 'off', attributes: {percentage: 0}},
        apply: (ha, entity, level) => ha.call('fan', 'set_percentage', entity, {percentage: Math.round(level * 100)}),
        on: 'ON',
        off: 'OFF',
    },
    cover: {
        read: (entity) => fraction(numericAttribute(entity, 'current_position'), 100),
        step: () => STEP,
        optimistic: (level) => ({
            state: level > 0 ? 'open' : 'closed',
            attributes: {current_position: Math.round(level * 100)},
        }),
        apply: (ha, entity, level) => ha.call('cover', 'set_cover_position', entity, {position: Math.round(level * 100)}),
        on: 'OPEN',
        off: 'CLOSED',
    },
}

/**
 * The dial a Home Assistant entity lends the shared knob: turning steps its
 * level (brightness, fan speed, cover position) live and debounced, the knob
 * toggles, and the readout comes from the entity's own domain. Returns null for
 * a domain with nothing to turn (a switch), so its key falls back to a plain
 * toggle.
 */
export function entityDial(ha: HomeAssistantService, label: string, entity: string): Dial | null {
    const domain = DIAL_DOMAINS[entityDomain(entity)]
    if (!domain) return null
    const control = new EntityLevel(ha, entity, domain)
    const turn = (direction: number): Binding => ({action: {type: 'noop'}, run: () => control.step(direction)})
    return {
        label,
        left: turn(-1),
        right: turn(1),
        press: haBinding(ha, 'toggle', entity),
        detail: () => {
            const on = isEntityOn(ha.entity(entity))
            if (on === undefined) return '--'
            const level = control.level()
            if (level === undefined) return on ? domain.on : domain.off
            return percent(level)
        },
        level: () => control.level(),
    }
}

/**
 * The one dial with no fixed job: it delegates to whichever dial a key last
 * handed it. A sticky claim (a room key) stays until replaced; a transient
 * claim (a playlist picker) expires after idle time and is dropped when another
 * dial is touched.
 */
export class DynamicDial implements Dial {
    readonly #model: ControlModel
    #held: Dial | null = null
    #reveal: (() => void) | null = null
    #transient = false
    #idleTimer: NodeJS.Timeout | null = null

    constructor(model: ControlModel) {
        this.#model = model
    }

    get label(): string {
        return this.#held?.label ?? IDLE_LABEL
    }

    get left(): Binding | undefined {
        return this.#active(this.#held?.left)
    }

    get right(): Binding | undefined {
        return this.#active(this.#held?.right)
    }

    get press(): Binding | undefined {
        return this.#active(this.#held?.press)
    }

    detail(): string {
        return this.#held?.detail() ?? IDLE_DETAIL
    }

    level(): number | undefined {
        return this.#held?.level?.()
    }

    /** A transient claim keeps its readout on the strip until confirmed or expired. */
    pinned(): boolean {
        return this.#transient && this.#held !== null
    }

    /** Wired by the layout once the strip exists, since the dial is built before it. */
    revealOn(reveal: () => void): void {
        this.#reveal = reveal
    }

    claim(dial: Dial, transient = false): void {
        const changed = this.#held !== dial
        this.#held = dial
        this.#transient = transient
        if (transient) this.#rearm()
        else this.#stopIdle()
        // Reveal even on a re-press: pressing BLINDS twice usually means "show me
        // where they are".
        this.#reveal?.()
        // Keys draw whether they hold the dial, so the whole panel is stale now.
        if (changed) this.#model.notify()
    }

    release(): void {
        this.#stopIdle()
        this.#transient = false
        if (!this.#held) return
        this.#held = null
        this.#model.notify()
    }

    /** Called by the renderer when another dial is touched; sticky claims stay. */
    autoRelease(): void {
        if (this.#transient) this.release()
    }

    holds(dial: Dial): boolean {
        return this.#held === dial
    }

    /** Running a transient claim's binding also restarts its idle timer. */
    #active(binding: Binding | undefined): Binding | undefined {
        if (!binding) return undefined
        return {
            action: binding.action,
            run: () => {
                if (this.#transient) this.#rearm()
                return binding.run()
            },
        }
    }

    #rearm(): void {
        this.#stopIdle()
        this.#idleTimer = setTimeout(() => this.release(), CLAIM_TIMEOUT_MILLISECONDS)
        this.#idleTimer.unref()
    }

    #stopIdle(): void {
        if (this.#idleTimer) clearTimeout(this.#idleTimer)
        this.#idleTimer = null
    }
}
