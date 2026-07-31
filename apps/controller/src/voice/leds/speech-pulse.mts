import type {LedAnimation, SignalDemand} from './animation.mjs'
import {TAU} from './animation.mjs'
import type {ColorInput} from './color.mjs'
import {rgb, scaleColor} from './color.mjs'
import type {LedSignals} from '../../types.mjs'
import {LED_COUNT} from '../../types.mjs'

const FRAME_MILLISECONDS = 40

// A pause between words should still read as the assistant holding the floor,
// so silence sits at a dim glow the shimmer stays visible on rather than at a
// trough that reads as the ring having stopped.
const FLOOR = 0.22

const SHIMMER = 0.25
const SHIMMER_PERIOD_MILLISECONDS = 1400
const SHIMMER_CYCLES = 2

/** The whole ring swelling with the level the assistant is speaking at. */
export class SpeechPulse implements LedAnimation {
    readonly color: number
    readonly framePeriodMs = FRAME_MILLISECONDS
    readonly demand: SignalDemand = {mic: false, speech: true}

    constructor(color: ColorInput) {
        this.color = rgb(color)
    }

    ring(nowMs: number, signals: LedSignals): readonly number[] {
        const level = Math.max(0, Math.min(1, signals.speechLevel()))
        return Array.from({length: LED_COUNT}, (_, index) => {
            const phase = (index / LED_COUNT) * SHIMMER_CYCLES
                - nowMs / SHIMMER_PERIOD_MILLISECONDS
            const shimmer = 1 - SHIMMER + SHIMMER * (Math.cos(phase * TAU) + 1) / 2
            return scaleColor(this.color, (FLOOR + (1 - FLOOR) * level) * shimmer)
        })
    }
}
