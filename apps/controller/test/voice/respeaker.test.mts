import assert from 'node:assert/strict'
import test from 'node:test'

import { ReSpeakerController } from '../../src/voice/respeaker.mjs'
import type { LedStateSpec } from '../../src/types.mjs'

test('ReSpeaker LEDs follow voice, media, and mute state', async () => {
  const rendered: [LedStateSpec, number, number][] = []
  const controller = new ReSpeakerController({
    config: {
      enabled: true,
      vendor_id: 0x2886,
      product_id: 0x001a,
      brightness: 64,
      speed: 2,
      states: {
        idle: { effect: 'doa', color: '#102030', accent: '#00bcd4' },
        listening: { effect: 'breath', color: '#00e5ff' },
        media_player_playing: { effect: 'single', color: '#1565c0' },
        muted: { effect: 'single', color: '#d50000' },
        disconnected: { effect: 'single', color: '#d50000' },
      },
    },
    device: {
      apply: async (spec, brightness, speed) => { rendered.push([spec, brightness, speed]) },
    },
  })

  await controller.handleEvent({ event: 'snapshot', data: { ha_connected: true, muted: false } })
  await controller.handleEvent({ event: 'listening' })
  assert.deepEqual(rendered.at(-1), [{ effect: 'breath', color: '#00e5ff' }, 64, 2])

  await controller.handleEvent({ event: 'media_player_playing' })
  await controller.handleEvent({ event: 'media_player_idle' })
  assert.deepEqual(rendered.at(-1), [{ effect: 'doa', color: '#102030', accent: '#00bcd4' }, 64, 2])

  // Mute overrides whatever voice state is active until it is lifted.
  await controller.handleEvent({ event: 'muted', data: { muted: true } })
  assert.deepEqual(rendered.at(-1)?.[0], { effect: 'single', color: '#d50000' })
  await controller.handleEvent({ event: 'muted', data: { muted: false } })
  assert.deepEqual(rendered.at(-1)?.[0], { effect: 'doa', color: '#102030', accent: '#00bcd4' })
})

test('LED-only mode does not force a disconnected warning', () => {
  const controller = new ReSpeakerController({
    voiceEnabled: false,
    config: {
      enabled: true,
      vendor_id: 0x2886,
      product_id: 0x001a,
      brightness: 64,
      speed: 2,
      states: {
        idle: { effect: 'doa', color: '#001018' },
        disconnected: { effect: 'breath', color: '#d50000' },
      },
    },
    device: { apply: async () => {} },
  })

  assert.deepEqual(controller.desired(), { effect: 'doa', color: '#001018' })
})

test('ReSpeaker USB failures are retried without flooding the journal', async () => {
  let now = 0
  const warnings: unknown[][] = []
  const controller = new ReSpeakerController({
    now: () => now,
    warningIntervalMilliseconds: 30_000,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    config: {
      enabled: true,
      vendor_id: 0x2886,
      product_id: 0x001a,
      brightness: 64,
      speed: 2,
      states: { idle: { effect: 'doa', color: '#001018' } },
    },
    device: { apply: async () => { throw new Error('not connected') } },
  })

  await controller.render(true)
  now = 500
  await controller.render(true)
  now = 30_000
  await controller.render(true)
  assert.equal(warnings.length, 2)
})
