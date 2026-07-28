import type {LedSignals} from '../../types.mjs'

/** Which live levels a face paints from, so nothing is measured unseen. */
export interface SignalDemand {
    mic: boolean
    speech: boolean
}

export const NO_SIGNALS: SignalDemand = {mic: false, speech: false}

/**
 * One face of the ring, which knows how to draw itself at any instant. Every
 * frame is derived from `nowMs` and the live signals rather than from retained
 * state, so a missed tick cannot drift an animation and a test can pin the clock.
 */
export interface LedAnimation {
    /** How often the ring must be redrawn; absent when the face never changes. */
    readonly framePeriodMs?: number

    /** Absent when the face reads no live audio. */
    readonly demand?: SignalDemand

    /** Every LED's colour at this instant, or null to darken the ring. */
    ring(nowMs: number, signals: LedSignals): readonly number[] | null
}

/** Levels for a ring drawn with nothing listening or speaking. */
export const silentSignals: LedSignals = {
    micLevel: () => 0,
    micDirection: () => null,
    speechLevel: () => 0,
}

export const TAU = Math.PI * 2
