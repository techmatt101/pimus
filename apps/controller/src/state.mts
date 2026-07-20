import type { ControlState, LvaMessage } from './types.mjs'

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

export function applyLvaEvent(state: ControlState, message: LvaMessage): ControlState {
  const data = message.data || {}
  if (message.event === 'snapshot') {
    state.muted = Boolean(data.muted)
    state.volume = Number(data.volume ?? 1)
    state.assist = data.ha_connected ? 'IDLE' : 'DISCONNECTED'
  } else if (message.event === 'muted') {
    state.muted = Boolean(data.muted)
  } else if (message.event === 'volume_changed') {
    state.volume = Number(data.volume)
  } else if (message.event === 'media_player_playing') {
    state.media = true
  } else if (message.event === 'idle' || message.event === 'tts_finished') {
    state.assist = 'IDLE'
  } else if (message.event === 'disconnected') {
    state.assist = 'DISCONNECTED'
  } else if (message.event) {
    state.assist = String(message.event).toUpperCase()
  }
  return state
}
