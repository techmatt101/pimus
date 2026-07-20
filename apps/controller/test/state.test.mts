import assert from 'node:assert/strict'
import test from 'node:test'

import { applyLvaEvent, createState } from '../src/state.mjs'

test('LVA snapshots and events update shared display state', () => {
  const state = createState()
  applyLvaEvent(state, { event: 'snapshot', data: { muted: true, volume: 0.42, ha_connected: true } })
  assert.deepEqual(state, {
    assist: 'IDLE',
    muted: true,
    volume: 0.42,
    outputMuted: false,
    media: false,
  })

  applyLvaEvent(state, { event: 'wake_word_detected' })
  assert.equal(state.assist, 'WAKE_WORD_DETECTED')
  applyLvaEvent(state, { event: 'media_player_playing' })
  assert.equal(state.media, true)
  applyLvaEvent(state, { event: 'media_player_paused' })
  assert.equal(state.media, false)
  applyLvaEvent(state, { event: 'volume_changed', data: { volume: 0.8 } })
  assert.equal(state.volume, 0.8)
  applyLvaEvent(state, { event: 'volume_changed' })
  assert.equal(state.volume, 0.8)
})

test('non-pipeline events leave the assist display state alone', () => {
  const state = createState({ assist: 'LISTENING' })
  applyLvaEvent(state, { event: 'light_command' })
  applyLvaEvent(state, { event: 'zeroconf', data: { status: 'connected' } })
  assert.equal(state.assist, 'LISTENING')
  applyLvaEvent(state, { event: 'timer_ticking' })
  assert.equal(state.assist, 'TIMER_TICKING')
  state.assist = 'LISTENING'
  applyLvaEvent(state, { event: 'timer_updated' })
  assert.equal(state.assist, 'TIMER_TICKING')
})
