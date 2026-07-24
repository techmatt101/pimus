// A Home Assistant entity as a dial, derived from its own domain exactly as
// EntityToggleTile derives its service: a light dims, a fan changes speed, a
// cover opens further. Pressing the knob toggles the entity, so the dial is the
// key without reaching back across the deck.
//
// This is what the room keys hand to the shared dial when pressed
// (streamdeck/dials/dynamic-dial.mts). A domain with nothing worth turning — a
// switch, a lock — is simply absent from the table below, and `EntityDial.for`
// returns nothing rather than a knob that turns and does nothing.

import {entityDomain, type HaActionName} from '../../actions/catalog.mjs'
import {isEntityOn, numericAttribute} from '../../home-assistant/entity.mjs'
import {type Binding, createBindings, type TileServices} from '../bindings.mjs'
import {type Dial, fraction, percent} from './dial.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

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

export class EntityDial implements Dial {
    readonly left: Binding
    readonly right: Binding
    readonly press: Binding
    private readonly ha: HomeAssistantService
    private readonly entity: string
    private readonly domain: DialDomain

    private constructor(
        services: TileServices,
        readonly label: string,
        entity: string,
        domain: DialDomain,
    ) {
        const {ha} = createBindings(services)
        this.ha = services.ha
        this.entity = entity
        this.domain = domain
        this.left = ha(domain.down, entity)
        this.right = ha(domain.up, entity)
        this.press = ha('toggle', entity)
    }

    /**
     * The dial for an entity, or undefined when its domain has nothing to turn.
     * Built through a factory rather than a constructor because "this entity is
     * not turnable" is an answer a key needs back, not a failure.
     */
    static for(services: TileServices, label: string, entity: string): EntityDial | undefined {
        const domain = DIAL_DOMAINS[entityDomain(entity)]
        return domain ? new EntityDial(services, label, entity, domain) : undefined
    }

    detail(): string {
        const current = this.read()
        const on = isEntityOn(current)
        // An unreachable Home Assistant must not read as a light turned down to
        // nothing, the same rule the Home Assistant keys follow.
        if (on === undefined) return '--'
        const level = this.domain.level(current)
        if (level === undefined) return on ? this.domain.on : this.domain.off
        return percent(level)
    }

    level(): number | undefined {
        return this.domain.level(this.read())
    }

    private read(): HomeAssistantEntity | undefined {
        return this.ha.entity(this.entity)
    }
}
