import assert from 'node:assert/strict'
import test from 'node:test'

import {
  durationSeconds,
  formatDuration,
  isEntityOn,
  numericAttribute,
  numericState,
  timerRemainingSeconds,
} from '../../src/home-assistant/entity.mjs'
import type { HomeAssistantEntity } from '../../src/types.mjs'

const entity = (state: string, attributes: Record<string, unknown> = {}): HomeAssistantEntity =>
  ({ entity_id: 'test.entity', state, attributes })

test('an entity reads as on, off, or genuinely unknown', () => {
  assert.equal(isEntityOn(entity('on')), true)
  assert.equal(isEntityOn(entity('open')), true, 'a cover is on while open')
  assert.equal(isEntityOn(entity('playing')), true)
  assert.equal(isEntityOn(entity('off')), false)
  assert.equal(isEntityOn(entity('closed')), false)

  // Unknown is its own answer, not "off": a key must be able to say it does not
  // know rather than claim the fan is switched off because Home Assistant is
  // unreachable.
  assert.equal(isEntityOn(undefined), undefined)
  assert.equal(isEntityOn(entity('unavailable')), undefined)
  assert.equal(isEntityOn(entity('unknown')), undefined)
})

test('sensor readings are numbers only when they really are numbers', () => {
  assert.equal(numericState(entity('21.4')), 21.4)
  assert.equal(numericState(entity('-3')), -3)
  assert.equal(numericState(entity('unavailable')), undefined)
  assert.equal(numericState(undefined), undefined)

  assert.equal(numericAttribute(entity('sunny', { temperature: 12 }), 'temperature'), 12)
  assert.equal(numericAttribute(entity('sunny', {}), 'temperature'), undefined)
  assert.equal(numericAttribute(entity('sunny', { temperature: 'warm' }), 'temperature'), undefined)
})

test('durations parse from both the H:MM:SS strings and plain seconds', () => {
  assert.equal(durationSeconds('0:05:00'), 300)
  assert.equal(durationSeconds('1:02:03'), 3723)
  assert.equal(durationSeconds('90'), 90)
  assert.equal(durationSeconds(45), 45)
  assert.equal(durationSeconds('later'), undefined)
  assert.equal(durationSeconds(undefined), undefined)
})

test('a running timer counts down from finishes_at, a paused one holds', () => {
  const now = Date.parse('2026-07-21T10:00:00Z')
  const running = entity('active', {
    finishes_at: '2026-07-21T10:04:12+00:00',
    duration: '0:05:00',
    remaining: '0:05:00',
  })

  // Home Assistant does not tick, so the countdown has to come from the finish
  // time rather than from the `remaining` attribute frozen at the start.
  assert.equal(timerRemainingSeconds(running, now), 252)
  assert.equal(timerRemainingSeconds(running, now + 12_000), 240)
  assert.equal(timerRemainingSeconds(running, now + 600_000), 0, 'never counts past zero')

  // A paused timer reports the remaining it stopped at and must not keep falling.
  const paused = entity('paused', { duration: '0:05:00', remaining: '0:03:20' })
  assert.equal(timerRemainingSeconds(paused, now), 200)
  assert.equal(timerRemainingSeconds(paused, now + 60_000), 200)

  assert.equal(timerRemainingSeconds(entity('idle', { duration: '0:05:00' }), now), 300)
  assert.equal(timerRemainingSeconds(undefined, now), undefined)
})

test('a countdown reads as M:SS, or H:MM once an hour is left', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(9), '0:09')
  assert.equal(formatDuration(252), '4:12')
  assert.equal(formatDuration(3723), '1:02')
  assert.equal(formatDuration(-5), '0:00', 'a finished timer never shows a negative')
})
