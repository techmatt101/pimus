import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../src/state.mjs'
import { dialDetail, keyAppearance } from '../../src/streamdeck/renderer.mjs'
import type { StreamDeckKey } from '../../src/types.mjs'

test('key appearances follow the catalog indicator for the bound action', () => {
  const state = createState({ muted: true, volume: 0.67, media: true })

  const audioKey: StreamDeckKey = {
    label: 'AUX',
    color: '#4a148c',
    action: { type: 'audio', source: 'aux', command: 'toggle' },
  }
  assert.deepEqual(keyAppearance(audioKey, state, { sources: { aux: true } }), {
    label: 'AUX ON',
    background: '#1b5e20',
  })
  assert.deepEqual(keyAppearance(audioKey, state, { sources: {} }), {
    label: 'AUX OFF',
    background: '#4a148c',
  })

  const muteKey: StreamDeckKey = {
    label: 'MIC',
    color: '#000000',
    action: { type: 'lva', command: 'mute_toggle' },
  }
  assert.deepEqual(keyAppearance(muteKey, state), { label: 'MIC OFF', background: '#d50000' })
  assert.deepEqual(keyAppearance(muteKey, createState()), { label: 'MIC', background: '#000000' })

  const voiceKey: StreamDeckKey = {
    label: 'VOICE',
    color: '#006064',
    action: { type: 'lva', command: 'start_listening' },
  }
  assert.equal(keyAppearance(voiceKey, createState({ assist: 'WAKE_WORD_DETECTED' })).background, '#00b8d4')
  assert.equal(keyAppearance(voiceKey, createState({ assist: 'IDLE' })).background, '#006064')

  // An action with no indicator keeps exactly what the inventory configured.
  const webhookKey: StreamDeckKey = {
    label: 'LIGHTS',
    color: '#333333',
    action: { type: 'webhook', id: 'office_lights' },
  }
  assert.deepEqual(keyAppearance(webhookKey, state), { label: 'LIGHTS', background: '#333333' })
})

test('dial readouts follow their bound actions rather than dial position', () => {
  const state = createState({ volume: 0.67 })
  const volumeDial = {
    label: 'VOLUME',
    left: { type: 'audio', command: 'down' },
    right: { type: 'audio', command: 'up' },
    press: { type: 'audio', command: 'mute' },
  } as const

  // The volume dial reports volume wherever it sits in streamdeck_dials.
  assert.equal(dialDetail(state, { sources: {} }, volumeDial), '67%')
  state.outputMuted = true
  assert.equal(dialDetail(state, { sources: {} }, volumeDial), 'MUTED')

  assert.equal(dialDetail(state, { sources: { aux: true } }, {
    label: 'AUX',
    press: { type: 'audio', source: 'aux', command: 'toggle' },
  }), 'ON')
  assert.equal(dialDetail(state, { sources: { usb: false } }, {
    label: 'USB',
    left: { type: 'audio', source: 'usb', command: 'off' },
  }), 'OFF')

  // A dial bound to neither volume nor a route falls back to the assist state.
  assert.equal(dialDetail(createState({ assist: 'LISTENING' }), { sources: {} }, {
    label: 'VOICE',
    press: { type: 'lva', command: 'start_listening' },
  }), 'LISTENING')
})
