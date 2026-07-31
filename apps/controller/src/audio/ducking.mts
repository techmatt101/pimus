import type {LvaMessage} from '../types.mjs'

const ACTIVE_EVENTS = new Set([
    'wake_word_detected',
    'listening',
    // Already ducked by listening in a run heard from the start, but it is the
    // first event a controller connecting mid-request is replayed.
    'transcribing',
    'thinking',
    'tts_speaking',
    'timer_ringing',
])

const RELEASE_EVENTS = new Set([
    'idle',
    'tts_finished',
    'pipeline_error',
    'disconnected',
])

/** Returns the requested duck state, or null when the event is irrelevant. */
export function duckingForEvent(message: LvaMessage | undefined): boolean | null {
    const event = String(message?.event || '')
    if (ACTIVE_EVENTS.has(event)) return true
    if (RELEASE_EVENTS.has(event) || event === 'snapshot') return false
    return null
}

export interface VoiceDuckerOptions {
    /** Forwards the request to the audio manager's control socket. */
    setDuck: (active: boolean) => void
}

/**
 * Turns voice pipeline events into duck requests on the audio manager socket.
 *
 * There is no lease to refresh and no state to clean up on exit: the manager
 * holds the request against this socket, so ending the process releases it.
 */
export class VoiceDucker {
    active = false
    readonly #setDuck: (active: boolean) => void

    constructor({setDuck}: VoiceDuckerOptions) {
        this.#setDuck = setDuck
    }

    setActive(active: boolean): void {
        if (this.active === active) return
        this.active = active
        this.#setDuck(active)
    }

    handleEvent(message: LvaMessage | undefined): void {
        const active = duckingForEvent(message)
        if (active !== null) this.setActive(active)
    }

    release(): void {
        this.setActive(false)
    }
}
