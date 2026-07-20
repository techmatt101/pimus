import assert from 'node:assert/strict'
import test from 'node:test'

import { createActionHandler } from '../../src/streamdeck/actions.mjs'
import { color, createImage } from '../../src/streamdeck/bitmap.mjs'
import { dialDetail, keyAppearance } from '../../src/streamdeck/display.mjs'
import { applyLvaEvent, createState } from '../../src/streamdeck/state.mjs'
import { parseOutputState } from '../../src/streamdeck/system-control.mjs'

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
})

test('key and dial appearances reflect audio and voice state', () => {
  const state = createState({ muted: true, volume: 0.67, media: true })
  const audioKey = { label: 'AUX', color: '#4a148c', action: { type: 'audio', source: 'aux' } }
  assert.deepEqual(keyAppearance(audioKey, state, { sources: { aux: true } }), {
    label: 'AUX ON',
    background: '#1b5e20',
  })

  const muteKey = { label: 'MIC', color: '#000000', action: { command: 'mute_toggle' } }
  assert.deepEqual(keyAppearance(muteKey, state), { label: 'MIC OFF', background: '#d50000' })
  assert.equal(dialDetail(0, state), '67%')
  state.outputMuted = true
  assert.equal(dialDetail(0, state), 'MUTED')
})

test('action handler routes device and LVA commands', async () => {
  const state = createState({ muted: false, media: true })
  const lvaCommands = []
  const controlCommands = []
  let changes = 0
  const handle = createActionHandler({
    state,
    lva: { send: (command) => lvaCommands.push(command) },
    control: (args) => controlCommands.push(args),
    onStateChange: () => { changes += 1 },
  })

  await handle({ type: 'lva', command: 'mute_toggle' })
  await handle({ type: 'lva', command: 'stop' })
  await handle({ type: 'audio', source: 'usb', command: 'toggle' })
  await handle({ type: 'led', command: 'cycle' })

  assert.deepEqual(lvaCommands, ['mute_mic', 'stop_timer_ringing', 'stop_pipeline', 'stop_media_player'])
  assert.deepEqual(controlCommands, [
    ['source', 'usb', 'toggle'],
    ['lights', 'cycle'],
  ])
  assert.equal(state.media, false)
  assert.equal(changes, 1)
})

test('webhook actions encode their identifier', async () => {
  const requests = []
  const handle = createActionHandler({
    state: createState(),
    lva: { send: () => {} },
    control: () => {},
    webhookBase: 'http://homeassistant.local:8123/api/webhook/',
    request: async (...args) => { requests.push(args) },
  })
  await handle({ type: 'webhook', id: 'movie mode' })
  assert.deepEqual(requests, [[
    'http://homeassistant.local:8123/api/webhook/movie%20mode',
    { method: 'POST' },
  ]])
})

test('bitmap and PipeWire parsers produce deterministic values', () => {
  assert.deepEqual(color('#102030'), [16, 32, 48])
  assert.deepEqual([...createImage(1, 1, '#010203').buffer], [1, 2, 3])
  assert.deepEqual(parseOutputState('Volume: 0.55 [MUTED]'), { volume: 0.55, outputMuted: true })
})
