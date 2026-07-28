import type {AudioState, ControlState, LvaEventData, LvaMessage, TimerState} from './types.mjs'

// Pipeline states shown on the assist dial. The LVA socket also carries
// non-pipeline traffic (light_command, zeroconf, media and volume updates)
// that must not clobber the displayed state.
const ASSIST_EVENTS = new Set([
    'wake_word_detected',
    'listening',
    'thinking',
    'tts_speaking',
    'timer_ringing',
    'pipeline_error',
])

// A live pipeline also wakes a sleeping panel (streamdeck/sleep.mts); derived
// from ASSIST_EVENTS so the two cannot drift apart.
export const LIVE_ASSIST_STATES: ReadonlySet<string> = new Set(
    [...ASSIST_EVENTS].map((event) => event.toUpperCase()),
)

const PIPELINE_EVENTS: ReadonlySet<string> = new Set([
    ...ASSIST_EVENTS,
    'snapshot',
    'disconnected',
    'idle',
    'tts_finished',
    'timer_ticking',
    'timer_updated',
])

/** Whether an event moves the pipeline on, as opposed to the socket's other traffic. */
export function changesPipeline(event: string | undefined): boolean {
    return event !== undefined && PIPELINE_EVENTS.has(event)
}

export const DEFAULT_BRIGHTNESS = 40

export function createState(overrides: Partial<ControlState> = {}): ControlState {
    return {
        assist: 'DISCONNECTED',
        timer: null,
        muted: false,
        volume: 1,
        outputMuted: false,
        media: false,
        panel: 'lit',
        brightness: DEFAULT_BRIGHTNESS,
        // Optimistic until the health monitor's first sample, so boot does not
        // open with every icon red and a burst of "lost" banners.
        health: {network: true, ha: true, audio: true, usbPlayback: false},
        ...overrides,
    }
}

export type Unsubscribe = () => void

/**
 * The observable control-surface model: whoever mutates `state` calls
 * `notify()`; the renderer repaints from it, and a mounted tile may subscribe
 * directly.
 */
export class ControlModel {
    readonly #listeners = new Set<() => void>()
    readonly state: ControlState
    readonly #readAudio: () => AudioState

    constructor(
        state: ControlState,
        readAudio: () => AudioState = () => ({sources: {}}),
    ) {
        this.state = state
        this.#readAudio = readAudio
    }

    get audio(): AudioState {
        return this.#readAudio()
    }

    subscribe(listener: () => void): Unsubscribe {
        this.#listeners.add(listener)
        return () => {
            this.#listeners.delete(listener)
        }
    }

    notify(): void {
        // Copy first so a listener that unsubscribes mid-notification is safe.
        for (const listener of [...this.#listeners]) listener()
    }
}

const TIMER_EVENTS = new Set(['timer_ticking', 'timer_updated', 'timer_ringing'])

function readTimer(data: LvaEventData, now: number, ringing: boolean): TimerState {
    const secondsLeft = Math.max(0, Number(data.seconds_left ?? 0))
    // The reading was taken when LVA emitted it, which is not when it arrived:
    // a reconnecting controller is replayed the state cached mid-timer.
    const takenAt = data.emitted_at === undefined ? now : data.emitted_at * 1000
    return {
        id: String(data.id ?? ''),
        name: String(data.name ?? ''),
        totalSeconds: Math.max(0, Number(data.total_seconds ?? 0)),
        secondsLeft,
        endsAt: takenAt + secondsLeft * 1000,
        active: data.is_active ?? true,
        ringing,
    }
}

export function applyLvaEvent(state: ControlState, message: LvaMessage, now = Date.now()): ControlState {
    const data = message.data || {}
    if (message.event && TIMER_EVENTS.has(message.event)) {
        state.timer = readTimer(data, now, message.event === 'timer_ringing')
    } else if (
        message.event === 'timer_cancelled'
        || message.event === 'disconnected'
        // A live timer is replayed straight after the snapshot, so starting a
        // connection with none is what says the last one is gone.
        || message.event === 'snapshot'
        // A ticking timer outlives the idle that ends an unrelated voice
        // pipeline; only the one that was ringing is finished with.
        || (message.event === 'idle' && state.timer?.ringing)
    ) {
        state.timer = null
    }

    if (message.event === 'snapshot') {
        state.muted = Boolean(data.muted)
        state.volume = Number(data.volume ?? 1)
        state.assist = data.ha_connected ? 'IDLE' : 'DISCONNECTED'
    } else if (message.event === 'muted') {
        state.muted = Boolean(data.muted)
    } else if (message.event === 'volume_changed') {
        // A malformed payload must not put NaN on the volume dial.
        const volume = Number(data.volume)
        if (Number.isFinite(volume)) state.volume = volume
    } else if (message.event === 'media_player_playing') {
        state.media = true
    } else if (message.event === 'media_player_paused' || message.event === 'media_player_idle') {
        state.media = false
    } else if (message.event === 'idle' || message.event === 'tts_finished') {
        state.assist = 'IDLE'
    } else if (message.event === 'disconnected') {
        state.assist = 'DISCONNECTED'
    } else if (message.event === 'timer_ticking' || message.event === 'timer_updated') {
        state.assist = 'TIMER_TICKING'
    } else if (message.event && ASSIST_EVENTS.has(message.event)) {
        state.assist = message.event.toUpperCase()
    }
    return state
}
