import type {LedFrame, LedSignals} from '../types.mjs'
import {LED_COUNT, LedEffect} from '../types.mjs'

export type LedAppearance =
    | { kind: 'off' }
    | { kind: 'solid'; color: number; brightness?: number }
    /** The firmware breathing effect: the colour swells and fades. */
    | { kind: 'pulse'; color: number; brightness?: number; speed?: number }
    /** The firmware rainbow cycle across the ring. */
    | { kind: 'rainbow'; brightness?: number; speed?: number }
    /** A fixed colour per LED. */
    | { kind: 'colors'; colors: readonly number[]; brightness?: number }
    /** The colour list rotating around the ring — a loading spinner. */
    | { kind: 'spin'; colors: readonly number[]; periodMs: number; brightness?: number }
    | { kind: 'blink'; color: number; periodMs: number; brightness?: number }
    /** A fraction of the ring lit, for readouts such as volume. */
    | { kind: 'progress'; fraction: number; color: number; background: number; brightness?: number }
    /** The firmware direction-of-arrival effect: the LEDs facing the detected
     *  voice light in the highlight colour over the base. */
    | { kind: 'direction'; base: number; highlight: number; brightness?: number }
    /** Ripples running outwards from the speaker, riding the microphone level. */
    | { kind: 'listenWave'; base: number; highlight: number; brightness?: number }
    /** The whole ring swelling with the assistant's own speech. */
    | { kind: 'speechPulse'; color: number; brightness?: number }

export type ColorInput = number | string

/** Packs a `#rrggbb` string (or passes a packed number through) as 0xRRGGBB. */
export function rgb(value: ColorInput): number {
    if (typeof value === 'number') return value & 0xFFFFFF
    const parsed = Number.parseInt(value.replace(/^#/, ''), 16)
    return Number.isFinite(parsed) ? parsed & 0xFFFFFF : 0
}

/** Scales a packed colour towards black; used for spinner tails. */
export function scaleColor(color: number, factor: number): number {
    const f = Math.max(0, Math.min(1, factor))
    const channel = (shift: number) => Math.round(((color >> shift) & 0xFF) * f) << shift
    return channel(16) | channel(8) | channel(0)
}

/** Blends two packed colours, `amount` running from all of `from` to all of `to`. */
export function mixColor(from: number, to: number, amount: number): number {
    const t = Math.max(0, Math.min(1, amount))
    const channel = (shift: number) => {
        const start = (from >> shift) & 0xFF
        return Math.round(start + (((to >> shift) & 0xFF) - start) * t) << shift
    }
    return channel(16) | channel(8) | channel(0)
}

/** Evenly spaced hues around the wheel, one per LED by default. */
export function rainbowColors(count = LED_COUNT): number[] {
    return Array.from({length: count}, (_, index) => {
        const hue = (index / count) * 6
        const ramp = Math.round(255 * (1 - Math.abs((hue % 2) - 1)))
        const [r, g, b] = hue < 1 ? [255, ramp, 0]
            : hue < 2 ? [ramp, 255, 0]
                : hue < 3 ? [0, 255, ramp]
                    : hue < 4 ? [0, ramp, 255]
                        : hue < 5 ? [ramp, 0, 255]
                            : [255, 0, ramp]
        return (r << 16) | (g << 8) | b
    })
}

/** A bright head fading to dark across the ring, for single-colour spinners. */
export function cometColors(color: ColorInput, tail = 8): number[] {
    const head = rgb(color)
    return Array.from({length: LED_COUNT}, (_, index) =>
        index < tail ? scaleColor(head, (1 - index / tail) ** 2) : 0)
}

/** Repeats or truncates a colour list to exactly one entry per LED. */
function ringOf(colors: readonly ColorInput[]): number[] {
    if (colors.length === 0) return Array(LED_COUNT).fill(0)
    return Array.from({length: LED_COUNT}, (_, index) => rgb(colors[index % colors.length] ?? 0))
}

const DEFAULT_SPIN_MS = 1200
const DEFAULT_BLINK_MS = 800

interface Timing {
    brightness?: number;
    speed?: number;
    periodMs?: number
}

export const Leds = {
    off(): LedAppearance {
        return {kind: 'off'}
    },
    solid(color: ColorInput, options: Timing = {}): LedAppearance {
        return {kind: 'solid', color: rgb(color), brightness: options.brightness}
    },
    pulse(color: ColorInput, options: Timing = {}): LedAppearance {
        return {kind: 'pulse', color: rgb(color), brightness: options.brightness, speed: options.speed}
    },
    rainbow(options: Timing = {}): LedAppearance {
        return {kind: 'rainbow', brightness: options.brightness, speed: options.speed}
    },
    colors(colors: readonly ColorInput[], options: Timing = {}): LedAppearance {
        return {kind: 'colors', colors: ringOf(colors), brightness: options.brightness}
    },
    /** A colour list rotates as given; a single colour gets a fading tail. */
    spin(colors: ColorInput | readonly ColorInput[], options: Timing = {}): LedAppearance {
        const ring = Array.isArray(colors) ? ringOf(colors) : cometColors(colors as ColorInput)
        return {
            kind: 'spin',
            colors: ring,
            periodMs: options.periodMs ?? DEFAULT_SPIN_MS,
            brightness: options.brightness
        }
    },
    blink(color: ColorInput, options: Timing = {}): LedAppearance {
        return {
            kind: 'blink',
            color: rgb(color),
            periodMs: options.periodMs ?? DEFAULT_BLINK_MS,
            brightness: options.brightness
        }
    },
    progress(fraction: number, color: ColorInput, background: ColorInput = 0, options: Timing = {}): LedAppearance {
        return {
            kind: 'progress',
            fraction: Math.max(0, Math.min(1, fraction)),
            color: rgb(color),
            background: rgb(background),
            brightness: options.brightness,
        }
    },
    direction(base: ColorInput, highlight: ColorInput, options: Timing = {}): LedAppearance {
        return {kind: 'direction', base: rgb(base), highlight: rgb(highlight), brightness: options.brightness}
    },
    listenWave(base: ColorInput, highlight: ColorInput, options: Timing = {}): LedAppearance {
        return {kind: 'listenWave', base: rgb(base), highlight: rgb(highlight), brightness: options.brightness}
    },
    speechPulse(color: ColorInput, options: Timing = {}): LedAppearance {
        return {kind: 'speechPulse', color: rgb(color), brightness: options.brightness}
    },
} as const

const ANIMATED_FRAME_MILLISECONDS = 40

/** Which live levels an appearance reads while it is showing. */
export function signalDemand(appearance: LedAppearance): { mic: boolean; speech: boolean } {
    return {
        mic: appearance.kind === 'listenWave',
        speech: appearance.kind === 'speechPulse',
    }
}

/** Levels for a ring drawn with nothing listening or speaking. */
export const silentSignals: LedSignals = {
    micLevel: () => 0,
    micDirection: () => null,
    speechLevel: () => 0,
}

/** How often an animated appearance needs a fresh frame; null when static. */
export function framePeriodMs(appearance: LedAppearance): number | null {
    if (appearance.kind === 'spin') return Math.max(50, appearance.periodMs / LED_COUNT)
    if (appearance.kind === 'blink') return Math.max(100, appearance.periodMs / 2)
    if (appearance.kind === 'listenWave' || appearance.kind === 'speechPulse') {
        return ANIMATED_FRAME_MILLISECONDS
    }
    return null
}

const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const TAU = Math.PI * 2

/** The angle each LED faces, clockwise from the ring's zero mark. */
const ledAngle = (index: number) => (index / LED_COUNT) * TAU

/** The shorter way round the ring between two angles, so 350° and 10° are near. */
function angleBetween(from: number, to: number): number {
    const difference = Math.abs((from - to) % TAU)
    return Math.min(difference, TAU - difference)
}

// The ring keeps a dim presence at silence: dropping to black between syllables
// reads as the assistant having stopped listening rather than waiting.
const WAVE_FLOOR = 0.06
const WAVE_LENGTH_RADIANS = 2.2
const WAVE_PERIOD_MILLISECONDS = 900
// Gentle enough that a crest still reaches the back of the ring: a wave that
// dies halfway reads as one side of the ring being broken.
const WAVE_TRAVEL_FADE = 0.5
const WAVE_CREST_SHARPNESS = 1.5
const WAVE_FOCUS = 1.8
const WAVE_FOCUS_WEIGHT = 0.25
const WAVE_UNPLACED_SWELL = 0.35

const SPEECH_FLOOR = 0.1
const SPEECH_SHIMMER = 0.25
const SPEECH_SHIMMER_PERIOD_MILLISECONDS = 1400
const SPEECH_SHIMMER_CYCLES = 2

function listenWaveRing(
    appearance: { base: number; highlight: number },
    nowMs: number,
    signals: LedSignals,
): number[] {
    const level = Math.max(0, Math.min(1, signals.micLevel()))
    const direction = signals.micDirection()
    return Array.from({length: LED_COUNT}, (_, index) => {
        if (direction === null) {
            return mixColor(appearance.base, appearance.highlight,
                WAVE_FLOOR + level * WAVE_UNPLACED_SWELL)
        }
        const distance = angleBetween(ledAngle(index), direction)
        const phase = distance / WAVE_LENGTH_RADIANS - nowMs / WAVE_PERIOD_MILLISECONDS
        const crest = Math.max(0, Math.cos(phase * TAU)) ** WAVE_CREST_SHARPNESS
        const travelled = (1 - distance / Math.PI) ** WAVE_TRAVEL_FADE
        const focus = (1 - distance / Math.PI) ** WAVE_FOCUS
        const intensity = WAVE_FLOOR
            + level * Math.max(crest * travelled, focus * WAVE_FOCUS_WEIGHT)
        return mixColor(appearance.base, appearance.highlight, intensity)
    })
}

function speechPulseRing(color: number, nowMs: number, signals: LedSignals): number[] {
    const level = Math.max(0, Math.min(1, signals.speechLevel()))
    return Array.from({length: LED_COUNT}, (_, index) => {
        const phase = (index / LED_COUNT) * SPEECH_SHIMMER_CYCLES
            - nowMs / SPEECH_SHIMMER_PERIOD_MILLISECONDS
        const shimmer = 1 - SPEECH_SHIMMER + SPEECH_SHIMMER * (Math.cos(phase * TAU) + 1) / 2
        return scaleColor(color, (SPEECH_FLOOR + (1 - SPEECH_FLOOR) * level) * shimmer)
    })
}

/**
 * Resolves an appearance into the frame for one moment. Animation phase comes
 * from `nowMs`, never from retained state, so a missed tick cannot drift the
 * pattern and tests can pin the clock.
 */
export function resolveFrame(
    appearance: LedAppearance,
    nowMs: number,
    defaults: { brightness: number; speed: number },
    signals: LedSignals = silentSignals,
): LedFrame {
    const base: LedFrame = {
        effect: LedEffect.Off,
        brightness: byte(('brightness' in appearance ? appearance.brightness : undefined) ?? defaults.brightness),
        speed: byte(defaults.speed),
        color: 0,
    }
    switch (appearance.kind) {
        case 'off':
            return base
        case 'solid':
            return {...base, effect: LedEffect.Solid, color: appearance.color}
        case 'pulse':
            return {
                ...base,
                effect: LedEffect.Breath,
                color: appearance.color,
                speed: byte(appearance.speed ?? defaults.speed)
            }
        case 'rainbow':
            return {...base, effect: LedEffect.Rainbow, speed: byte(appearance.speed ?? defaults.speed)}
        case 'colors':
            return {...base, effect: LedEffect.Ring, ring: [...appearance.colors]}
        case 'spin': {
            const step = Math.floor(nowMs / Math.max(1, appearance.periodMs / LED_COUNT)) % LED_COUNT
            const ring = appearance.colors.map((_, index) =>
                appearance.colors[(index - step + LED_COUNT * 2) % LED_COUNT] ?? 0)
            return {...base, effect: LedEffect.Ring, ring}
        }
        case 'blink': {
            const on = Math.floor(nowMs / Math.max(1, appearance.periodMs / 2)) % 2 === 0
            return {...base, effect: LedEffect.Solid, color: on ? appearance.color : 0}
        }
        case 'progress': {
            const lit = Math.round(appearance.fraction * LED_COUNT)
            const ring = Array.from({length: LED_COUNT}, (_, index) =>
                index < lit ? appearance.color : appearance.background)
            return {...base, effect: LedEffect.Ring, ring}
        }
        case 'direction':
            return {
                ...base,
                effect: LedEffect.Doa,
                color: appearance.base,
                direction: {base: appearance.base, highlight: appearance.highlight},
            }
        case 'listenWave':
            return {
                ...base,
                effect: LedEffect.Ring,
                color: appearance.base,
                ring: listenWaveRing(appearance, nowMs, signals),
            }
        case 'speechPulse':
            return {
                ...base,
                effect: LedEffect.Ring,
                color: appearance.color,
                ring: speechPulseRing(appearance.color, nowMs, signals),
            }
    }
}
