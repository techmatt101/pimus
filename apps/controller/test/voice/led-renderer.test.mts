import assert from 'node:assert/strict'
import test from 'node:test'

import { Leds } from '../../src/voice/led-appearance.mjs'
import { LedRenderer } from '../../src/voice/led-renderer.mjs'
import { LedEffect } from '../../src/types.mjs'
import type { LedFrame } from '../../src/types.mjs'

test('a static appearance is written once and skipped until it changes', async () => {
  const frames: LedFrame[] = []
  const renderer = new LedRenderer({
    device: { apply: async (frame) => { frames.push(frame) } },
    brightness: 64,
    speed: 2,
    now: () => 0,
  })

  await renderer.show(Leds.solid('#1565c0'))
  await renderer.render()
  await renderer.render()
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0], { effect: LedEffect.Solid, brightness: 64, speed: 2, color: 0x1565c0 })

  await renderer.show(Leds.pulse('#00c853'))
  assert.equal(frames.length, 2)
  assert.equal(frames[1]?.effect, LedEffect.Breath)
})

test('an animated appearance produces a new frame as the clock advances', async () => {
  let now = 0
  const frames: LedFrame[] = []
  const renderer = new LedRenderer({
    device: { apply: async (frame) => { frames.push(frame) } },
    brightness: 64,
    speed: 2,
    now: () => now,
  })

  await renderer.show(Leds.spin(['#ff0000', '#000000'], { periodMs: 1200 }))
  await renderer.render()
  assert.equal(frames.length, 1)

  // The watchdog interval calls render(); the phase comes from the clock.
  now = 100
  await renderer.render()
  assert.equal(frames.length, 2)
  assert.equal(frames[1]?.ring?.[1], frames[0]?.ring?.[0])
})

test('USB failures retry on the next render without flooding the journal', async () => {
  let now = 0
  let failures = 0
  const warnings: unknown[][] = []
  const renderer = new LedRenderer({
    device: { apply: async () => { failures += 1; throw new Error('not connected') } },
    brightness: 64,
    speed: 2,
    now: () => now,
    warningIntervalMilliseconds: 30_000,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
  })

  await renderer.show(Leds.solid('#d50000'))
  now = 500
  await renderer.render()
  now = 30_000
  await renderer.render()
  assert.equal(failures, 3)
  assert.equal(warnings.length, 2)
})
