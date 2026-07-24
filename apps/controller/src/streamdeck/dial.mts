import type {Binding} from './bindings.mjs'

export interface Dial {
    readonly label: string
    /** Run on a counter-clockwise turn, once per detent. */
    readonly left?: Binding | undefined
    readonly right?: Binding | undefined
    readonly press?: Binding | undefined

    /**
     * The value line under the label. Must return something short and true even
     * when nothing is connected: "unknown" has to read as unknown rather than as
     * a confident zero.
     */
    detail(): string

    /** The reading as a 0-1 fraction, drawn as a bar; omit when the value is not a level. */
    level?(): number | undefined

    /** Whether this dial holds the strip on its readout beyond the short after-turn hold. */
    pinned?(): boolean
}

export function fraction(value: number | undefined, full: number): number | undefined {
    return value === undefined ? undefined : Math.max(0, Math.min(1, value / full))
}

export function percent(level: number): string {
    return `${Math.round(level * 100)}%`
}
