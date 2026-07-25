import type {HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

// Turning the dial nudges the cached level on every detent so the strip and key
// track the finger, but the device command is debounced: a fast spin coalesces
// into one absolute set once the dial settles, sparing the light, fan, or blind
// a burst of relative steps it would otherwise have to chew through.
const DEBOUNCE_MILLISECONDS = 250

export interface LevelDomain {
    /** The reported level as a 0..1 fraction, or undefined when off or unknown. */
    read(entity: HomeAssistantEntity | undefined): number | undefined
    /** One detent as a fraction of the range, read from the entity where it varies. */
    step(entity: HomeAssistantEntity | undefined): number
    /** The cached state and attributes to show for a just-set level. */
    optimistic(level: number): { state: string; attributes: Record<string, unknown> }
    /** Send the settled absolute level to Home Assistant. */
    apply(ha: HomeAssistantService, entity: string, level: number): void
}

export class EntityLevel {
    readonly #ha: HomeAssistantService
    readonly #entity: string
    readonly #domain: LevelDomain
    #timer: NodeJS.Timeout | null = null

    constructor(ha: HomeAssistantService, entity: string, domain: LevelDomain) {
        this.#ha = ha
        this.#entity = entity
        this.#domain = domain
    }

    level(): number | undefined {
        return this.#domain.read(this.#ha.entity(this.#entity))
    }

    step(direction: number): void {
        const entity = this.#ha.entity(this.#entity)
        if (!entity) return
        const current = this.#domain.read(entity) ?? 0
        const next = clamp(current + direction * this.#domain.step(entity))
        if (next === current) return
        const {state, attributes} = this.#domain.optimistic(next)
        this.#ha.patch(this.#entity, state, attributes)
        this.#schedule(next)
    }

    #schedule(level: number): void {
        if (this.#timer) clearTimeout(this.#timer)
        this.#timer = setTimeout(() => {
            this.#timer = null
            this.#domain.apply(this.#ha, this.#entity, level)
        }, DEBOUNCE_MILLISECONDS)
        this.#timer.unref()
    }
}

function clamp(level: number): number {
    return Math.max(0, Math.min(1, level))
}
