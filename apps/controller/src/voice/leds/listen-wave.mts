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

// The LED facing the speaker is held at full cyan as a marker, so the ripples
// running away from it are kept well below it; at equal brightness the crest
// travelling round the ring is mistaken for the direction.
const RIPPLE_CEILING = 0.45

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

/** One steady LED on whoever the microphone array is hearing, ripples off it. */
export class ListenWave implements LedAnimation {
    readonly base: number
    readonly highlight: number
    readonly framePeriodMs = FRAME_MILLISECONDS
    readonly demand: SignalDemand = {mic: true, speech: false}

    constructor(base: ColorInput, highlight: ColorInput) {
        this.base = rgb(base)
        this.highlight = rgb(highlight)
    }

    ring(nowMs: number, signals: LedSignals): readonly number[] {
        const level = Math.max(0, Math.min(1, signals.micLevel()))
        const direction = signals.micDirection()
        if (direction === null) {
            const swell = mixColor(this.base, this.highlight, FLOOR + level * UNPLACED_SWELL)
            return Array<number>(LED_COUNT).fill(swell)
        }
        const marker = nearestLed(direction)
        return Array.from({length: LED_COUNT}, (_, index) => index === marker
            ? this.highlight
            : mixColor(this.base, this.highlight, this.#ripple(index, direction, nowMs, level)))
    }

    #ripple(index: number, direction: number, nowMs: number, level: number): number {
        const distance = angleBetween(ledAngle(index), direction)
        const phase = distance / WAVE_LENGTH_RADIANS - nowMs / WAVE_PERIOD_MILLISECONDS
        const crest = Math.max(0, Math.cos(phase * TAU)) ** CREST_SHARPNESS
        const travelled = (1 - distance / Math.PI) ** TRAVEL_FADE
        const focus = (1 - distance / Math.PI) ** FOCUS
        const wave = level * Math.max(crest * travelled, focus * FOCUS_WEIGHT)
        return FLOOR + wave * RIPPLE_CEILING
    }
}
