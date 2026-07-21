import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../src/state.mjs'
import { createBindings } from '../../src/streamdeck/bindings.mjs'
import { testServices, type TestServices } from '../support/fixtures.mjs'
import type { ControlState } from '../../src/types.mjs'

/** Recording services whose model change notifications join the same journal. */
const recordingServices = (state: ControlState = createState()): TestServices => {
  const services = testServices(state)
  services.model.subscribe(() => services.calls.push('changed'))
  return services
}

test('bindings run the injected services and expose their declarative action', async () => {
  const services = recordingServices(createState({ muted: true }))
  const { voice, volume, route, none } = createBindings(services)

  const aux = route('aux', 'toggle')
  assert.deepEqual(aux.action, { type: 'audio', source: 'aux', command: 'toggle' })
  aux.run()

  const up = volume('up')
  assert.deepEqual(up.action, { type: 'audio', command: 'up' })
  up.run()

  // A catalogued voice command runs its behaviour; an uncatalogued one is
  // forwarded to LVA verbatim.
  voice('mute_toggle').run()
  voice('some_future_lva_command').run()
  await none().run()

  assert.deepEqual(services.calls, [
    'source:aux:toggle',
    'volume:up',
    'lva:unmute_mic',
    'lva:some_future_lva_command',
  ])
})

test('voice bindings notify the model when their runner changes state', () => {
  const state = createState({ media: true })
  const services = recordingServices(state)
  createBindings(services).voice('stop').run()

  assert.deepEqual(services.calls, [
    'lva:stop_timer_ringing',
    'lva:stop_pipeline',
    'lva:stop_media_player',
    'changed',
  ])
  assert.equal(state.media, false)
})

test('Home Assistant bindings derive the service from the entity domain', () => {
  const services = recordingServices()
  services.ha.put('media_player.office', 'playing', { shuffle: true })
  const { ha } = createBindings(services)

  const fan = ha('toggle', 'fan.office_ceiling')
  assert.deepEqual(fan.action, { type: 'ha', command: 'toggle', entity: 'fan.office_ceiling' })
  fan.run()
  // A cover is toggled by its own domain's service, with no layout change.
  ha('toggle', 'cover.office_blinds').run()

  // Shuffle is absolute in Home Assistant, so the binding reads the current
  // value back and asks for the opposite.
  ha('media_shuffle', 'media_player.office').run()
  ha('play_media', 'media_player.office', { media_content_id: 'x', media_content_type: 'playlist' }).run()

  assert.deepEqual(services.ha.calls, [
    'fan.toggle fan.office_ceiling',
    'cover.toggle cover.office_blinds',
    'media_player.shuffle_set media_player.office {"shuffle":false}',
    'media_player.play_media media_player.office {"media_content_id":"x","media_content_type":"playlist"}',
  ])
})

test('a timer binding starts an idle timer and cancels a running one', () => {
  const services = recordingServices()
  const timer = createBindings(services).ha('timer_toggle', 'timer.office', { duration: '00:05:00' })

  services.ha.put('timer.office', 'idle', {})
  timer.run()
  services.ha.put('timer.office', 'active', { finishes_at: '2026-07-21T10:05:00+00:00' })
  timer.run()

  assert.deepEqual(services.ha.calls, [
    'timer.start timer.office {"duration":"00:05:00"}',
    'timer.cancel timer.office',
  ])
})

test('webhook bindings encode their identifier and need a configured base', async () => {
  const requests: unknown[][] = []
  const services = recordingServices()
  services.webhookBase = 'http://homeassistant.local:8123/api/webhook/'
  services.request = async (...args: unknown[]) => { requests.push(args) }

  await createBindings(services).webhook('movie mode').run()
  assert.deepEqual(requests, [[
    'http://homeassistant.local:8123/api/webhook/movie%20mode',
    { method: 'POST' },
  ]])

  // Without a base URL the binding does nothing rather than fetching nowhere.
  services.webhookBase = undefined
  await createBindings(services).webhook('movie mode').run()
  assert.equal(requests.length, 1)
})
