// The dial that has no fixed job: it controls whatever you last touched.
//
// Three of the four dials are permanent — volume, media, and a spare — because
// a knob you have to look at is a knob you stop using. The fourth is the
// opposite bargain: pressing the lights, fan, or blinds key hands it that
// entity, so one dial covers every dimmable, variable-speed, part-open thing in
// the room without the deck growing a dial per device. A playlist key hands it a
// list to pick from the same way (streamdeck/selection-dial.mts).
//
// A key claims the dial as it is pressed (streamdeck/tiles/entity-toggle-tile.mts)
// and the strip shows the new readout straight away, so the thing you just
// pressed is also the thing under your hand.
//
// What turning does for an entity comes from its own domain, derived here from
// the `DIAL_DOMAINS` table exactly as `EntityToggleTile` derives its toggle
// service: a light dims, a fan changes speed, a cover opens further. A domain
// with nothing worth turning — a switch, a lock — is simply absent from the
// table, and `controlEntity` claims nothing rather than a knob that does nothing.
//
// A claim comes in two flavours. A room key's claim is sticky: the light stays
// under the knob while you page away and look at something else, until you claim
// something else. A playlist key's is transient — a modal "now pick one" it
// wants over quickly — so it asks to time out after fifteen idle seconds and to
// be dropped the moment a different dial is touched (the renderer calls
// `autoRelease`). Both fall back to the idle prompt; only the transient one lets
// go on its own.

import {entityDomain, type HaActionName} from '../../actions/catalog.mjs'
import {isEntityOn, numericAttribute} from '../../home-assistant/entity.mjs'
import {type Binding, createBindings, type TileServices} from '../bindings.mjs'
import {type Dial, fraction, percent} from '../dial.mjs'
import type {ControlModel} from '../../state.mjs'
import type {HomeAssistantEntity} from '../../types.mjs'

/** Shown before any key has claimed the dial, so it explains itself. */
const IDLE_LABEL = 'CONTROL'
const IDLE_DETAIL = 'PICK A KEY'

/** How long a claim survives with no turn or press before it releases itself. */
export const CLAIM_TIMEOUT_MILLISECONDS = 15_000

/** How one Home Assistant domain reads and moves as a dial. */
interface DialDomain {
    /** Bound to a counter-clockwise turn. */
    down: HaActionName
    /** Bound to a clockwise turn. */
    up: HaActionName

    /** The entity's value as a 0-1 fraction, or undefined when it reports none. */
    level(entity: HomeAssistantEntity | undefined): number | undefined

    /** Readout while on with no level to show, and while off. */
    on: string
    off: string
}

/**
 * The domains worth turning, keyed by entity domain. Add a domain here and its
 * stepping actions to the catalog; never give a device a dial of its own.
 */
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
 * The shared dial, delegating to whichever dial currently holds it. It is a
 * Dial like any other, reading its claim through getters at the moment of the
 * turn, so the deck and the strip need not know this one is any different from
 * the fixed three.
 */
export class DynamicDial implements Dial {
    readonly #model: ControlModel
    #held: Dial | null = null
    // The entity a room key is controlling, or null when the claim is a playlist
    // picker or nothing is held. Keys read this to draw their holding stripe.
    #entity: string | null = null
    #reveal: (() => void) | null = null
    // Whether the current claim is the transient, self-expiring kind. A sticky
    // claim (a room key) has no timer and ignores another dial being touched.
    #transient = false
    // Runs down while a transient claim sits idle; every turn or press restarts
    // it, and it releases the claim when it fires. Null whenever nothing is
    // claimed or the claim is sticky.
    #idle: NodeJS.Timeout | null = null

    constructor(model: ControlModel) {
        this.#model = model
    }

    get label(): string {
        return this.#held?.label ?? IDLE_LABEL
    }

    // Turning or pressing counts as activity, so each delegated binding restarts
    // the idle timer before it runs the held dial's own behaviour.
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

    /**
     * A transient claim keeps its readout on the strip for the whole claim, not
     * just the strip's short after-turn hold: while you are picking a playlist the
     * choice stays visible until you confirm or it times out. A sticky claim does
     * not pin — a light you adjusted should let the strip fall back to what is
     * playing once your hand leaves the knob.
     */
    pinned(): boolean {
        return this.#transient && this.#held !== null
    }

    /**
     * How to put this dial on the touch strip when it changes hands. Wired by the
     * layout once the strip exists, since the dial is built before it.
     */
    revealOn(reveal: () => void): void {
        this.#reveal = reveal
    }

    /**
     * Hand the dial to `dial`. A key calls this as it is pressed. A `transient`
     * claim (a playlist picker) times out and is dropped when another dial is
     * touched; the default sticky claim (a room key) stays until replaced.
     */
    claim(dial: Dial, transient = false): void {
        const changed = this.#held !== dial
        this.#held = dial
        this.#entity = null
        this.#transient = transient
        if (transient) this.#rearm()
        else this.#stopIdle()
        // Show the readout even on a re-press: the point of pressing BLINDS twice
        // is usually to look at where they are before turning them.
        this.#reveal?.()
        // Keys draw whether they hold the dial, so the whole panel is stale now.
        if (changed) this.#model.notify()
    }

    /**
     * Hand the dial a Home Assistant entity to turn — what a room key does as it
     * is pressed. The turn and readout come from the entity's domain; a domain
     * with nothing to turn (a switch) claims nothing and leaves the last claim in
     * place. The claim is sticky, so the entity stays under the knob across pages.
     */
    controlEntity(services: TileServices, label: string, entity: string): void {
        const domain = DIAL_DOMAINS[entityDomain(entity)]
        if (!domain) return
        this.claim(this.#entityDial(services, label, entity, domain))
        this.#entity = entity
    }

    /** Whether the dial is currently turning `entity`, for a room key's stripe. */
    controls(entity: string): boolean {
        return this.#entity === entity
    }

    /**
     * Let go of the current claim, falling back to the idle prompt. Called by the
     * idle timer and by a key that has finished with the dial (a confirmed
     * selection, or a picker paged out of sight). Safe to call when nothing is
     * held.
     */
    release(): void {
        this.#stopIdle()
        this.#transient = false
        this.#entity = null
        if (!this.#held) return
        this.#held = null
        this.#model.notify()
    }

    /**
     * Drop a transient claim because attention moved elsewhere — the renderer
     * calls this when a dial other than this one is touched. A sticky claim is
     * left alone: paging past a light you are still adjusting must not drop it.
     */
    autoRelease(): void {
        if (this.#transient) this.release()
    }

    /** Whether `dial` is the one holding it, for a key's own face. */
    holds(dial: Dial): boolean {
        return this.#held === dial
    }

    /**
     * A Home Assistant entity as a delegated dial, derived from its own domain: a
     * light dims, a fan changes speed, a cover opens further. Pressing the knob
     * toggles the entity, so the dial is the key without reaching back across the
     * deck. An unreachable Home Assistant reads `--` rather than a light turned
     * down to nothing, the same rule the Home Assistant keys follow.
     */
    #entityDial(services: TileServices, label: string, entity: string, domain: DialDomain): Dial {
        const {ha} = createBindings(services)
        const read = (): HomeAssistantEntity | undefined => services.ha.entity(entity)
        return {
            label,
            left: ha(domain.down, entity),
            right: ha(domain.up, entity),
            press: ha('toggle', entity),
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

    /**
     * Wrap a delegated binding so running a transient claim's binding also
     * restarts its idle timer: a knob that is being turned has not been
     * abandoned, so its claim should not expire out from under the hand on it. A
     * sticky claim has no timer to restart.
     */
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
        this.#idle = setTimeout(() => this.release(), CLAIM_TIMEOUT_MILLISECONDS)
        // A pending release must not keep the daemon alive on shutdown.
        this.#idle.unref()
    }

    #stopIdle(): void {
        if (this.#idle) clearTimeout(this.#idle)
        this.#idle = null
    }
}
