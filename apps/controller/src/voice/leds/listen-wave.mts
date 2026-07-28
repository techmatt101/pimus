import type {LedAnimation, SignalDemand} from './animation.mjs'
import {TAU} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {mixColor, rgb} from './color.mjs'
import type {LedSignals} from '../../types.mjs'
import {LED_COUNT} from '../../types.mjs'

const FRAME_MILLISECONDS = 40

// The ring keeps a dim presence at silence: dropping to black between syllables
// reads as the assistant having stopped listening rather than waiting.
const FLOOR = 0.06
const WAVE_LENGTH_RADIANS = 2.2
const WAVE_PERIOD_MILLISECONDS = 900
// Gentle enough that a crest still reaches the back of the ring: a wave that
// dies halfway reads as one side of the ring being broken.
const TRAVEL_FADE = 0.5
const CREST_SHARPNESS = 1.5
const FOCUS = 1.8
const FOCUS_WEIGHT = 0.25

// The LED facing the speaker never falls back to the ring's own floor, so the
// array keeps pointing at whoever last spoke through the gaps between their
// words. Speech brightens it the rest of the way, and the ripples are that
// brightening running away round the ring.
const MARKER_FLOOR = 0.3

// With nobody placed there is no origin to travel from, so the ring answers the
// level as a whole rather than faking a direction.
const UNPLACED_SWELL = 0.35

/** The angle each LED faces, clockwise from the ring's zero mark. */
const ledAngle = (index: number) => (index / LED_COUNT) * TAU

/** The shorter way round the ring between two angles, so 350° and 10° are near. */
function angleBetween(from: number, to: number): number {
    const difference = Math.abs((from - to) % TAU)
    return Math.min(difference, TAU - difference)
}

/** The one LED facing closest to an angle, whichever way the DSP reports it. */
function nearestLed(direction: number): number {
    let nearest = 0
    for (let index = 1; index < LED_COUNT; index++) {
        if (angleBetween(ledAngle(index), direction) < angleBetween(ledAngle(nearest), direction)) {
            nearest = index
        }
    }
    return nearest
}

/**
 * One LED on whoever the microphone array is hearing, ripples off it. The
 * marker and the ripples carry their own colours rather than one colour at two
 * brightnesses, so the direction reads as a different light and not just a
 * brighter one.
 */
export class ListenWave implements LedAnimation {
    readonly base: number
    readonly ripple: number
    readonly marker: number
    readonly framePeriodMs = FRAME_MILLISECONDS
    readonly demand: SignalDemand = {mic: true, speech: false}

    constructor(base: ColorInput, ripple: ColorInput, marker: ColorInput) {
        this.base = rgb(base)
        this.ripple = rgb(ripple)
        this.marker = rgb(marker)
    }

    ring(nowMs: number, signals: LedSignals): readonly number[] {
        const level = Math.max(0, Math.min(1, signals.micLevel()))
        const direction = signals.micDirection()
        // With nobody placed there is no marker to colour, so the ring answers
        // the level in the ripples' own colour.
        if (direction === null) {
            const swell = mixColor(this.base, this.ripple, FLOOR + level * UNPLACED_SWELL)
            return Array<number>(LED_COUNT).fill(swell)
        }
        const facing = nearestLed(direction)
        return Array.from({length: LED_COUNT}, (_, index) => index === facing
            ? mixColor(this.base, this.marker, MARKER_FLOOR + (1 - MARKER_FLOOR) * level)
            : mixColor(this.base, this.ripple, this.#ripple(index, direction, nowMs, level)))
    }

    #ripple(index: number, direction: number, nowMs: number, level: number): number {
        const distance = angleBetween(ledAngle(index), direction)
        const phase = distance / WAVE_LENGTH_RADIANS - nowMs / WAVE_PERIOD_MILLISECONDS
        const crest = Math.max(0, Math.cos(phase * TAU)) ** CREST_SHARPNESS
        const travelled = (1 - distance / Math.PI) ** TRAVEL_FADE
        const focus = (1 - distance / Math.PI) ** FOCUS
        return FLOOR + level * Math.max(crest * travelled, focus * FOCUS_WEIGHT)
    }
}
