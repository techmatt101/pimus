import {entityDomain, type HaActionName} from '../../actions/catalog.mjs'
import {isEntityOn, numericAttribute} from '../../home-assistant/entity.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {type Dial, fraction, percent} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

const IDLE_LABEL = 'CONTROL'
const IDLE_DETAIL = 'PICK A KEY'

export const CLAIM_TIMEOUT_MILLISECONDS = 15_000

interface DialDomain {
    down: HaActionName
    up: HaActionName

    level(entity: HomeAssistantEntity | undefined): number | undefined

    /** Readout while on with no level to show, and while off. */
    on: string
    off: string
}

const DIAL_DOMAINS: Record<string, DialDomain> = {
    light: {
        down: 'brightness_down',
        up: 'brightness_up',
        // Home Assistant reports brightness on 0-255, not as a percentage.
        level: (entity) => fraction(numericAttribute(entity, 'brightness'), 255),
        on: 'ON',
        off: 'OFF',
    },
    fan: {
        down: 'fan_speed_down',
        up: 'fan_speed_up',
        level: (entity) => fraction(numericAttribute(entity, 'percentage'), 100),
        on: 'ON',
        off: 'OFF',
    },
    cover: {
        down: 'cover_close',
        up: 'cover_open',
        level: (entity) => fraction(numericAttribute(entity, 'current_position'), 100),
        on: 'OPEN',
        off: 'CLOSED',
    },
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
    #entity: string | null = null
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
        this.#entity = null
        this.#transient = transient
        if (transient) this.#rearm()
        else this.#stopIdle()
        // Reveal even on a re-press: pressing BLINDS twice usually means "show me
        // where they are".
        this.#reveal?.()
        // Keys draw whether they hold the dial, so the whole panel is stale now.
        if (changed) this.#model.notify()
    }

    /**
     * Hand the dial a Home Assistant entity to turn. The turn and readout come
     * from the entity's domain; a domain with nothing to turn (a switch) claims
     * nothing and leaves the last claim in place.
     */
    controlEntity(ha: HomeAssistantService, label: string, entity: string): void {
        const domain = DIAL_DOMAINS[entityDomain(entity)]
        if (!domain) return
        this.claim(this.#entityDial(ha, label, entity, domain))
        this.#entity = entity
    }

    controls(entity: string): boolean {
        return this.#entity === entity
    }

    release(): void {
        this.#stopIdle()
        this.#transient = false
        this.#entity = null
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

    #entityDial(ha: HomeAssistantService, label: string, entity: string, domain: DialDomain): Dial {
        const read = (): HomeAssistantEntity | undefined => ha.entity(entity)
        return {
            label,
            left: haBinding(ha, domain.down, entity),
            right: haBinding(ha, domain.up, entity),
            press: haBinding(ha, 'toggle', entity),
            detail: () => {
                const current = read()
                const on = isEntityOn(current)
                if (on === undefined) return '--'
                const level = domain.level(current)
                if (level === undefined) return on ? domain.on : domain.off
                return percent(level)
            },
            level: () => domain.level(read()),
        }
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
