// The XVF3800's DSP readouts without the USB. The real device reports a speech
// energy per beam and a processed direction of arrival, going NaN whenever no
// beam holds speech; this synthesises somebody talking and slowly walking around
// the array, so the ring's listening wave has something to follow.

import type {VoiceSensing, VoiceSensor} from '../../controller/src/types.mjs'

const TAU = Math.PI * 2

/** Roughly a syllable rate, so the wave crests the way speech does. */
const SYLLABLES_PER_SECOND = 3.2
const PHRASES_PER_SECOND = 0.24
const CIRCUIT_SECONDS = 25

export class FakeVoiceSensor implements VoiceSensor {
    private readonly started = Date.now()

    async sense(): Promise<VoiceSensing> {
        const seconds = (Date.now() - this.started) / 1000
        const syllables = (Math.sin(seconds * TAU * SYLLABLES_PER_SECOND) + 1) / 2
        const phrase = Math.sin(seconds * TAU * PHRASES_PER_SECOND)
        // Between phrases the DSP reports silence and places nobody, which is
        // what makes the ring's direction hold worth having.
        if (phrase <= 0) return {direction: null, energy: 0}
        return {
            direction: (seconds / CIRCUIT_SECONDS) * TAU % TAU,
            energy: syllables ** 1.6 * phrase,
        }
    }
}
