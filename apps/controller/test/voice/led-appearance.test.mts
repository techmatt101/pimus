import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cometColors,
  framePeriodMs,
  Leds,
  rainbowColors,
  resolveFrame,
  rgb,
  scaleColor,
} from '../../src/voice/led-appearance.mjs'
import { LED_COUNT, LedEffect } from '../../src/types.mjs'

const DEFAULTS = { brightness: 64, speed: 2 }

test('colour helpers pack, scale, and spread hues', () => {
  assert.equal(rgb('#abcdef'), 0xabcdef)
  assert.equal(rgb(0x1abcdef0), 0xbcdef0)
  assert.equal(rgb('nonsense'), 0)
  assert.equal(scaleColor(0x804020, 0.5), 0x402010)
  const rainbow = rainbowColors()
  assert.equal(rainbow.length, LED_COUNT)
  assert.equal(new Set(rainbow).size, LED_COUNT)
  const comet = cometColors('#ff0000')
  assert.equal(comet[0], 0xff0000)
  assert.equal(comet.at(-1), 0)
})

test('static appearances resolve to firmware effects', () => {
  assert.deepEqual(resolveFrame(Leds.off(), 0, DEFAULTS),
    { effect: LedEffect.Off, brightness: 64, speed: 2, color: 0 })
  assert.deepEqual(resolveFrame(Leds.solid('#1565c0', { brightness: 200 }), 0, DEFAULTS),
    { effect: LedEffect.Solid, brightness: 200, speed: 2, color: 0x1565c0 })
  assert.deepEqual(resolveFrame(Leds.pulse('#00c853', { speed: 5 }), 0, DEFAULTS),
    { effect: LedEffect.Breath, brightness: 64, speed: 5, color: 0x00c853 })
  assert.equal(resolveFrame(Leds.rainbow(), 0, DEFAULTS).effect, LedEffect.Rainbow)
  const direction = resolveFrame(Leds.direction('#102030', '#00bcd4'), 0, DEFAULTS)
  assert.equal(direction.effect, LedEffect.Doa)
  assert.deepEqual(direction.direction, { base: 0x102030, highlight: 0x00bcd4 })
  assert.equal(framePeriodMs(Leds.solid('#fff')), null)
})

test('spin rotates its colours with the clock, so phase never drifts', () => {
  const spin = Leds.spin(rainbowColors(), { periodMs: 1200 })
  assert.equal(framePeriodMs(spin), 100)
  const at0 = resolveFrame(spin, 0, DEFAULTS)
  const at1 = resolveFrame(spin, 100, DEFAULTS)
  const wrapped = resolveFrame(spin, 1200, DEFAULTS)
  assert.equal(at1.ring?.[1], at0.ring?.[0])
  assert.deepEqual(wrapped.ring, at0.ring)
  assert.notDeepEqual(at1.ring, at0.ring)
})

test('blink and progress compute their frames from plain arithmetic', () => {
  const blink = Leds.blink('#ff6d00', { periodMs: 500 })
  assert.equal(resolveFrame(blink, 0, DEFAULTS).color, 0xff6d00)
  assert.equal(resolveFrame(blink, 250, DEFAULTS).color, 0)
  assert.equal(resolveFrame(blink, 500, DEFAULTS).color, 0xff6d00)
  const progress = resolveFrame(Leds.progress(0.5, '#ffffff', '#101010'), 0, DEFAULTS)
  assert.deepEqual(progress.ring, [...Array(6).fill(0xffffff), ...Array(6).fill(0x101010)])
})
