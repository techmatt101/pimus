import type {VoiceSensor} from '../types.mjs'

export interface MicSensorOptions {
    sensor: VoiceSensor
    intervalMilliseconds?: number
    now?: () => number
    logger?: Pick<Console, 'warn'>
}

const DEFAULT_INTERVAL_MILLISECONDS = 40

// The DSP documents speech energy only as "above 0 means speech, higher is
// louder": the scale is unspecified and moves with gain and distance. The level
// is therefore taken against a decaying running peak, over a fixed number of
// decades below it, so any array and any speaker fill the same 0..1.
const LEVEL_DECADES = 2
const PEAK_DECAY = 0.995
const SILENT_ENERGY = 1e-9

const ATTACK = 0.6
const RELEASE = 0.12

// A gap between syllables reports no direction; letting the wave snap back to
// the ring's zero mark between words looks like a fault rather than listening.
const DIRECTION_HOLD_MILLISECONDS = 2500

const WARNING_INTERVAL_MILLISECONDS = 30_000

/** A ring with no array behind it: never any speech, never a direction. */
export const silentSensor: VoiceSensor = {
    sense: async () => ({direction: null, energy: 0}),
}

/** The microphone array's own view of who is speaking and how loudly. */
export class MicSensor {
    #sensor: VoiceSensor
    #intervalMilliseconds: number
    #now: () => number
    #logger: Pick<Console, 'warn'>
    #timer: NodeJS.Timeout | null = null
    #polling = false
    #peak = 0
    #level = 0
    #direction: number | null = null
    #directionAt = Number.NEGATIVE_INFINITY
    #lastWarningAt = Number.NEGATIVE_INFINITY

    constructor({
                    sensor,
                    intervalMilliseconds = DEFAULT_INTERVAL_MILLISECONDS,
                    now = Date.now,
                    logger = console,
                }: MicSensorOptions) {
        this.#sensor = sensor
        this.#intervalMilliseconds = intervalMilliseconds
        this.#now = now
        this.#logger = logger
    }

    get running(): boolean {
        return this.#timer !== null
    }

    level(): number {
        return this.#level
    }

    direction(): number | null {
        if (this.#direction === null) return null
        if (this.#now() - this.#directionAt > DIRECTION_HOLD_MILLISECONDS) return null
        return this.#direction
    }

    start(): void {
        if (this.#timer) return
        this.#timer = setInterval(() => void this.sample(), this.#intervalMilliseconds)
        this.#timer.unref()
        void this.sample()
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
        this.#peak = 0
        this.#level = 0
        this.#direction = null
    }

    async sample(): Promise<void> {
        if (this.#polling) return
        this.#polling = true
        try {
            const sensed = await this.#sensor.sense()
            this.#apply(sensed.energy)
            if (sensed.direction !== null) {
                this.#direction = sensed.direction
                this.#directionAt = this.#now()
            }
        } catch (error) {
            this.#apply(0)
            this.#warn(error)
        } finally {
            this.#polling = false
        }
    }

    #apply(energy: number): void {
        this.#peak = Math.max(energy, this.#peak * PEAK_DECAY)
        const target = energy > SILENT_ENERGY && this.#peak > SILENT_ENERGY
            ? Math.max(0, Math.min(1, 1 + Math.log10(energy / this.#peak) / LEVEL_DECADES))
            : 0
        this.#level += (target - this.#level) * (target > this.#level ? ATTACK : RELEASE)
    }

    #warn(error: unknown): void {
        const now = this.#now()
        if (now - this.#lastWarningAt < WARNING_INTERVAL_MILLISECONDS) return
        this.#lastWarningAt = now
        this.#logger.warn('Unable to read the ReSpeaker microphone array', error)
    }
}
