import type {LvaMessage} from '../types.mjs'

export type DuckReason = 'voice' | 'media'

export type DuckChange = Partial<Record<DuckReason, boolean>>

const VOICE_ACTIVE_EVENTS = new Set([
    'wake_word_detected',
    'listening',
    // Already ducked by listening in a run heard from the start, but it is the
    // first event a controller connecting mid-request is replayed.
    'transcribing',
    'thinking',
    'tts_speaking',
    'timer_ringing',
])

const VOICE_RELEASE_EVENTS = new Set([
    'idle',
    'tts_finished',
    'pipeline_error',
])

// The assistant's own media player plays on the voice bus too: a clip Home
// Assistant sends it is as loud over the music as a spoken reply.
const MEDIA_RELEASE_EVENTS = new Set([
    'media_player_paused',
    'media_player_idle',
])

const RESET_EVENTS = new Set([
    'snapshot',
    'disconnected',
])

/** Returns which duck reasons the event switches, or null when it touches none. */
export function duckChangeForEvent(message: LvaMessage | undefined): DuckChange | null {
    const event = String(message?.event || '')
    if (RESET_EVENTS.has(event)) return {voice: false, media: false}
    if (VOICE_ACTIVE_EVENTS.has(event)) return {voice: true}
    if (VOICE_RELEASE_EVENTS.has(event)) return {voice: false}
    if (event === 'media_player_playing') return {media: true}
    if (MEDIA_RELEASE_EVENTS.has(event)) return {media: false}
    return null
}

export interface VoiceDuckerOptions {
    /** Forwards the request to the audio manager's control socket. */
    setDuck: (active: boolean) => void
}

/**
 * Turns voice pipeline and media player events into duck requests on the
 * audio manager socket. The two are held apart, so a clip ending does not
 * restore the music under a reply, nor a reply ending under a clip.
 *
 * There is no lease to refresh and no state to clean up on exit: the manager
 * holds the request against this socket, so ending the process releases it.
 */
export class VoiceDucker {
    active = false
    readonly #reasons = new Set<DuckReason>()
    readonly #setDuck: (active: boolean) => void

    constructor({setDuck}: VoiceDuckerOptions) {
        this.#setDuck = setDuck
    }

    handleEvent(message: LvaMessage | undefined): void {
        const change = duckChangeForEvent(message)
        if (change === null) return
        for (const [reason, active] of Object.entries(change) as [DuckReason, boolean][]) {
            if (active) this.#reasons.add(reason)
            else this.#reasons.delete(reason)
        }
        this.#apply()
    }

    release(): void {
        this.#reasons.clear()
        this.#apply()
    }

    #apply(): void {
        const active = this.#reasons.size > 0
        if (this.active === active) return
        this.active = active
        this.#setDuck(active)
    }
}
