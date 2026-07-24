// The Dial contract: one of the four knobs under the touch strip, and the
// rotary counterpart of a Tile. A dial owns what turning and pressing it does
// and what it reads out, and each dial class lives in its own file in this
// folder; dials are created by the layout factory (streamdeck/layout.mts) with
// the controller's services injected, so a dial carries its behaviour with it
// instead of the strip inferring behaviour from what it happens to be bound to.
//
// A dial does not paint: the four share one face, drawn across the whole strip
// by DialScreen (streamdeck/screens/dial-screen.mts) while a knob is being
// turned. What a dial owns is the content of that face — its name, its reading,
// and whether that reading is a level — which is why `detail` is required. A
// dial that cannot say what it reads has nothing to show mid-turn.

import type {Binding} from '../bindings.mjs'

export interface Dial {
    /** The name shown above the reading while this dial is being turned. */
    readonly label: string
    /** Run on a counter-clockwise turn, once per detent. */
    readonly left?: Binding | undefined
    /** Run on a clockwise turn. */
    readonly right?: Binding | undefined
    /** Run when the knob is pressed. */
    readonly press?: Binding | undefined

    /**
     * The value line under the label. Required, and must return something short
     * and true even when nothing is connected: the strip shows this the instant a
     * hand touches the knob, so "unknown" has to read as unknown rather than as a
     * confident zero. A dial reads the live state it reports from directly — its
     * injected model or Home Assistant — rather than being handed it.
     */
    detail(): string

    /**
     * The reading as a 0-1 fraction, drawn as a bar under it. Only for a dial
     * whose value really is a level — volume, brightness, how far open — since a
     * bar is what makes a value readable while the knob is still moving. A dial
     * with nothing to plot omits this.
     */
    level?(): number | undefined

    /**
     * Whether this dial should hold the strip on its own readout regardless of
     * the strip's short after-turn hold, until it says otherwise. The shared dial
     * pins itself while a key is mid-pick (a transient claim) so the selection
     * stays on the strip for the whole claim rather than dropping to now-playing
     * a couple of seconds after the last turn. Almost every dial omits this and
     * gets only the short hold.
     */
    pinned?(): boolean
}

/** A reported value as a fraction of its full scale, or undefined. */
export function fraction(value: number | undefined, full: number): number | undefined {
    return value === undefined ? undefined : Math.max(0, Math.min(1, value / full))
}

/** A 0-1 level as the percentage every dial reads out. */
export function percent(level: number): string {
    return `${Math.round(level * 100)}%`
}
