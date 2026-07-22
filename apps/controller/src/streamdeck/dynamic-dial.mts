// The dial that has no fixed job: it controls whatever you last touched.
//
// Three of the four dials are permanent — volume, media, and a spare — because
// a knob you have to look at is a knob you stop using. The fourth is the
// opposite bargain: pressing the lights, fan, or blinds key hands it that
// entity, so one dial covers every dimmable, variable-speed, part-open thing in
// the room without the deck growing a dial per device.
//
// A key claims the dial as it is pressed (streamdeck/tiles/entity-toggle-tile.mts)
// and the strip shows the new readout straight away, so the thing you just
// pressed is also the thing under your hand.

import { entityDomain, type HaActionName } from '../actions/catalog.mjs'
import { isEntityOn, numericAttribute } from '../home-assistant/entity.mjs'
import { createBindings, type Binding, type TileServices } from './bindings.mjs'
import type { StreamDeckDial } from './grid.mjs'
import type { TileContext } from './tiles/tile.mjs'
import type { ControlModel } from '../state.mjs'
import type { HomeAssistantEntity } from '../types.mjs'

/**
 * Something the dynamic dial can be handed. It is exactly what a fixed dial is
 * — a label, up to three bindings, and its own readout — because a claimed dial
 * should behave no differently from one wired into the layout.
 */
export type DialControl = StreamDeckDial

/** Shown before any key has claimed the dial, so it explains itself. */
const IDLE_LABEL = 'CONTROL'
const IDLE_DETAIL = 'PICK A KEY'

/**
 * The shared dial, delegating to whichever control currently holds it. It
 * satisfies StreamDeckDial through getters, so the deck and the strip read it
 * at the moment of the turn and see the current claim without knowing this
 * dial is any different from the fixed ones.
 */
export class DynamicDial implements StreamDeckDial {
  private control: DialControl | null = null
  private reveal: (() => void) | null = null

  constructor(private readonly model: ControlModel) {}

  get label(): string {
    return this.control?.label ?? IDLE_LABEL
  }

  get left(): Binding | undefined {
    return this.control?.left
  }

  get right(): Binding | undefined {
    return this.control?.right
  }

  get press(): Binding | undefined {
    return this.control?.press
  }

  detail(context: TileContext): string {
    return this.control?.detail?.(context) ?? (this.control ? this.control.label : IDLE_DETAIL)
  }

  level(context: TileContext): number | undefined {
    return this.control?.level?.(context)
  }

  /**
   * How to put this dial on the touch strip when it changes hands. Wired by the
   * layout once the strip exists, since the dial is built before it.
   */
  revealOn(reveal: () => void): void {
    this.reveal = reveal
  }

  /** Hand the dial to `control`. A key calls this as it is pressed. */
  claim(control: DialControl): void {
    const changed = this.control !== control
    this.control = control
    // Show the readout even on a re-press: the point of pressing BLINDS twice
    // is usually to look at where they are before turning them.
    this.reveal?.()
    // Keys draw whether they hold the dial, so the whole panel is stale now.
    if (changed) this.model.notify()
  }

  /** Whether `control` is the one holding the dial, for a key's own face. */
  holds(control: DialControl): boolean {
    return this.control === control
  }
}

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

/** A reported value as a fraction of its full scale, or undefined. */
const fraction = (value: number | undefined, full: number): number | undefined =>
  value === undefined ? undefined : Math.max(0, Math.min(1, value / full))

/**
 * The domains worth turning, keyed by entity domain. A domain with nothing to
 * turn — a switch, a lock — is simply absent, and its key claims no dial rather
 * than claiming one that does nothing.
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
 * The dial control for an entity, derived from its own domain the same way
 * EntityToggleTile derives its service: a light dims, a fan changes speed, a
 * cover opens further. Returns undefined for a domain with nothing to turn.
 *
 * Pressing the dial toggles the entity, so the knob is the key without reaching
 * back across the deck.
 */
export function entityDial(services: TileServices, label: string, entity: string): DialControl | undefined {
  const domain = DIAL_DOMAINS[entityDomain(entity)]
  if (!domain) return undefined

  const { ha } = createBindings(services)
  const read = (): HomeAssistantEntity | undefined => services.ha.entity(entity)
  return {
    label,
    left: ha(domain.down, entity),
    right: ha(domain.up, entity),
    press: ha('toggle', entity),
    detail: () => {
      const current = read()
      const on = isEntityOn(current)
      // An unreachable Home Assistant must not read as a light at zero.
      if (on === undefined) return '--'
      const level = domain.level(current)
      if (level === undefined) return on ? domain.on : domain.off
      return `${Math.round(level * 100)}%`
    },
    // A level reads as a bar far faster than as digits while the knob is
    // moving; an entity reporting none draws no bar at all.
    level: () => domain.level(read()),
  }
}
