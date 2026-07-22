import assert from 'node:assert/strict'
import test from 'node:test'

import { Leds } from '../../src/voice/led-appearance.mjs'
import { ReSpeakerController } from '../../src/voice/respeaker.mjs'
import { LedEffect } from '../../src/types.mjs'
import type { LedFrame, ReSpeakerConfig } from '../../src/types.mjs'

const CONFIG: ReSpeakerConfig = {
  enabled: true,
  vendor_id: 0x2886,
  product_id: 0x001a,
  brightness: 64,
}

// The appearances asserted here come from the compiled state map in
// voice/led-states.mts, the same way layout.test.mts reads the compiled deck.
test('ReSpeaker LEDs follow voice, media, and mute state', async () => {
  const rendered: LedFrame[] = []
  const controller = new ReSpeakerController({
    config: CONFIG,
    device: {
      apply: async (frame) => { rendered.push(frame) },
    },
  })

  await controller.handleEvent({ event: 'snapshot', data: { ha_connected: true, muted: false } })
  await controller.handleEvent({ event: 'listening' })
  assert.deepEqual(rendered.at(-1), {
    effect: LedEffect.Doa,
    brightness: 64,
    speed: 2,
    color: 0x001018,
    direction: { base: 0x001018, highlight: 0x00e5ff },
  })

  await controller.handleEvent({ event: 'media_player_playing' })
  assert.deepEqual(rendered.at(-1),
    { effect: LedEffect.Solid, brightness: 64, speed: 2, color: 0x1565c0 })
  await controller.handleEvent({ event: 'media_player_idle' })
  assert.deepEqual(rendered.at(-1), {
    effect: LedEffect.Doa,
    brightness: 64,
    speed: 2,
    color: 0x102030,
    direction: { base: 0x102030, highlight: 0x00bcd4 },
  })

  // Mute overrides whatever voice state is active until it is lifted.
  await controller.handleEvent({ event: 'muted', data: { muted: true } })
  assert.equal(rendered.at(-1)?.color, 0xd50000)
  await controller.handleEvent({ event: 'muted', data: { muted: false } })
  assert.equal(rendered.at(-1)?.effect, LedEffect.Doa)
})

test('LED-only mode does not force a disconnected warning', () => {
  const controller = new ReSpeakerController({
    voiceEnabled: false,
    config: CONFIG,
    device: { apply: async () => {} },
  })

  assert.deepEqual(controller.desired(), Leds.direction('#102030', '#00bcd4'))
})

test('ReSpeaker USB failures are retried without flooding the journal', async () => {
  let now = 0
  const warnings: unknown[][] = []
  const controller = new ReSpeakerController({
    now: () => now,
    warningIntervalMilliseconds: 30_000,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    config: CONFIG,
    device: { apply: async () => { throw new Error('not connected') } },
  })

  await controller.render()
  now = 500
  await controller.render()
  now = 30_000
  await controller.render()
  assert.equal(warnings.length, 2)
})
