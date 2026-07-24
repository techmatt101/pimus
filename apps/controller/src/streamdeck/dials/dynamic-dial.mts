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

import type {Binding} from '../bindings.mjs'
import type {Dial} from './dial.mjs'
import type {ControlModel} from '../../state.mjs'

/** Shown before any key has claimed the dial, so it explains itself. */
const IDLE_LABEL = 'CONTROL'
const IDLE_DETAIL = 'PICK A KEY'

/**
 * The shared dial, delegating to whichever dial currently holds it. It is a
 * Dial like any other, reading its claim through getters at the moment of the
 * turn, so the deck and the strip need not know this one is any different from
 * the fixed three.
 */
export class DynamicDial implements Dial {
    private held: Dial | null = null
    private reveal: (() => void) | null = null

    constructor(private readonly model: ControlModel) {
    }

    get label(): string {
        return this.held?.label ?? IDLE_LABEL
    }

    get left(): Binding | undefined {
        return this.held?.left
    }

    get right(): Binding | undefined {
        return this.held?.right
    }

    get press(): Binding | undefined {
        return this.held?.press
    }

    detail(): string {
        return this.held?.detail() ?? IDLE_DETAIL
    }

    level(): number | undefined {
        return this.held?.level?.()
    }

    /**
     * How to put this dial on the touch strip when it changes hands. Wired by the
     * layout once the strip exists, since the dial is built before it.
     */
    revealOn(reveal: () => void): void {
        this.reveal = reveal
    }

    /** Hand the dial to `dial`. A key calls this as it is pressed. */
    claim(dial: Dial): void {
        const changed = this.held !== dial
        this.held = dial
        // Show the readout even on a re-press: the point of pressing BLINDS twice
        // is usually to look at where they are before turning them.
        this.reveal?.()
        // Keys draw whether they hold the dial, so the whole panel is stale now.
        if (changed) this.model.notify()
    }

    /** Whether `dial` is the one holding it, for a key's own face. */
    holds(dial: Dial): boolean {
        return this.held === dial
    }
}
