import type { AudioState, ControlState, LvaMessage } from './types.mjs'

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

export function createState(overrides: Partial<ControlState> = {}): ControlState {
  return {
    assist: 'DISCONNECTED',
    muted: false,
    volume: 1,
    outputMuted: false,
    media: false,
    ...overrides,
  }
}

export type Unsubscribe = () => void

/**
 * The observable control-surface model: the mutable display state, a live view
 * of the audio manager's route state, and a change subscription. Whoever
 * mutates `state` (the LVA client, the volume monitor, a tile) calls
 * `notify()`; the renderer repaints from it, and a mounted tile may subscribe
 * directly when it needs to react to changes itself — starting an animation,
 * say — rather than only being repainted.
 */
export class ControlModel {
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly state: ControlState,
    private readonly readAudio: () => AudioState = () => ({ sources: {} }),
  ) {}

  get audio(): AudioState {
    return this.readAudio()
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify(): void {
    // Copy first so a listener that unsubscribes mid-notification is safe.
    for (const listener of [...this.listeners]) listener()
  }
}

export function applyLvaEvent(state: ControlState, message: LvaMessage): ControlState {
  const data = message.data || {}
  if (message.event === 'snapshot') {
    state.muted = Boolean(data.muted)
    state.volume = Number(data.volume ?? 1)
    state.assist = data.ha_connected ? 'IDLE' : 'DISCONNECTED'
  } else if (message.event === 'muted') {
    state.muted = Boolean(data.muted)
  } else if (message.event === 'volume_changed') {
    // A malformed payload must not put NaN on the volume dial; the output
    // monitor poll remains the authoritative writer while the deck is up.
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
