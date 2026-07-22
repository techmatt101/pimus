import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveFrame } from '../../src/voice/led-appearance.mjs'
import { VOICE_LED_STATES } from '../../src/voice/led-states.mjs'

// The states respeaker.mts reaches for by name: the fallback, the mute
// override, the LVA-disconnect appearance, and the two it maps events onto.
const REQUIRED = ['idle', 'muted', 'disconnected', 'media_player_playing', 'timer_ticking']

test('the compiled state map carries every state the controller reaches for', () => {
  for (const name of REQUIRED) {
    assert.ok(VOICE_LED_STATES.has(name), `led-states.mts must keep a "${name}" entry`)
  }
})

test('every compiled state resolves to a renderable frame', () => {
  for (const [name, appearance] of VOICE_LED_STATES) {
    const frame = resolveFrame(appearance, 0, { brightness: 64, speed: 2 })
    assert.ok(frame.brightness > 0 || appearance.kind === 'off', `state "${name}" would render dark`)
    if (frame.ring) assert.equal(frame.ring.length, 12, `state "${name}" must colour all 12 LEDs`)
  }
})
