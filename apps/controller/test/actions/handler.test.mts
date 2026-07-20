import assert from 'node:assert/strict'
import test from 'node:test'

import { createActionHandler } from '../../src/actions/handler.mjs'
import { VOICE_ACTIONS } from '../../src/actions/catalog.mjs'
import { createState } from '../../src/state.mjs'

test('action handler routes device and LVA commands', async () => {
  const state = createState({ muted: false, media: true })
  const lvaCommands: string[] = []
  const sourceCommands: [string, string][] = []
  const volumeCommands: string[] = []
  let changes = 0
  const handle = createActionHandler({
    state,
    lva: { send: (command) => { lvaCommands.push(command) } },
    setSource: (name, command) => sourceCommands.push([name, command]),
    setVolume: (command) => volumeCommands.push(command),
    onStateChange: () => { changes += 1 },
  })

  await handle({ type: 'lva', command: 'mute_toggle' })
  await handle({ type: 'lva', command: 'stop' })
  await handle({ type: 'audio', source: 'usb', command: 'toggle' })
  await handle({ type: 'audio', command: 'up' })

  assert.deepEqual(lvaCommands, ['mute_mic', 'stop_timer_ringing', 'stop_pipeline', 'stop_media_player'])
  assert.deepEqual(sourceCommands, [['usb', 'toggle']])
  assert.deepEqual(volumeCommands, ['up'])
  assert.equal(state.media, false)
  assert.equal(changes, 1)
})

test('every catalogued voice action reaches the LVA socket', async () => {
  for (const command of Object.keys(VOICE_ACTIONS)) {
    const lvaCommands: string[] = []
    const handle = createActionHandler({
      state: createState(),
      lva: { send: (sent) => { lvaCommands.push(sent) } },
      setSource: () => {},
      setVolume: () => {},
    })
    await handle({ type: 'lva', command })
    assert.ok(lvaCommands.length > 0, `${command} sent nothing to LVA`)
  }
})

test('uncatalogued LVA commands are forwarded unchanged', async () => {
  const lvaCommands: string[] = []
  const handle = createActionHandler({
    state: createState(),
    lva: { send: (command) => { lvaCommands.push(command) } },
    setSource: () => {},
    setVolume: () => {},
  })
  await handle({ type: 'lva', command: 'some_future_lva_command' })
  await handle({ type: 'noop' })
  await handle(undefined)
  assert.deepEqual(lvaCommands, ['some_future_lva_command'])
})

test('webhook actions encode their identifier', async () => {
  const requests: unknown[][] = []
  const handle = createActionHandler({
    state: createState(),
    lva: { send: () => {} },
    setSource: () => {},
    setVolume: () => {},
    webhookBase: 'http://homeassistant.local:8123/api/webhook/',
    request: async (...args: unknown[]) => { requests.push(args) },
  })
  await handle({ type: 'webhook', id: 'movie mode' })
  assert.deepEqual(requests, [[
    'http://homeassistant.local:8123/api/webhook/movie%20mode',
    { method: 'POST' },
  ]])
})
