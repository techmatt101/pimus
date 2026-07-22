import assert from 'node:assert/strict'
import test from 'node:test'

import { AudioModeTile } from '../../../src/streamdeck/tiles/audio-mode-tile.mjs'
import { testContext, testServices, tileFace } from '../../support/fixtures.mjs'

const MODES = [
  { label: 'STREAM', color: '#004d40' },
  { label: 'AUX', color: '#4a148c', source: 'aux' },
  { label: 'USB', color: '#0d47a1', source: 'usb' },
]

test('pressing cycles the input and reconciles every route it owns', () => {
  const services = testServices()
  const tile = new AudioModeTile(services, { modes: MODES })

  // From the sourceless mode, the first press moves to aux and turns usb off.
  tile.press(testContext())
  assert.deepEqual(services.calls, ['source:aux:on', 'source:usb:off'])

  services.calls.length = 0
  tile.press(testContext(undefined, { sources: { aux: true } }))
  assert.deepEqual(services.calls, ['source:aux:off', 'source:usb:on'])

  // The cycle wraps back to the sourceless mode with everything off.
  services.calls.length = 0
  tile.press(testContext(undefined, { sources: { usb: true } }))
  assert.deepEqual(services.calls, ['source:aux:off', 'source:usb:off'])
})

test('the current mode is read back from the audio manager, not remembered', () => {
  const services = testServices()
  const tile = new AudioModeTile(services, { modes: MODES })

  const stream = tileFace(tile, testContext())
  const aux = tileFace(tile, testContext(undefined, { sources: { aux: true } }))
  const usb = tileFace(tile, testContext(undefined, { sources: { usb: true } }))
  assert.notDeepEqual(stream, aux)
  assert.notDeepEqual(aux, usb)

  // A route switched by a dial rather than this key still shows here, because
  // nothing about the current mode is kept inside the tile.
  assert.deepEqual(tileFace(tile, testContext(undefined, { sources: { aux: true } })), aux)
})

test('a press from a state with two routes on repairs it to exactly one', () => {
  const services = testServices()
  const tile = new AudioModeTile(services, { modes: MODES })

  // aux wins the "which mode is showing" race, so the press moves on to usb and
  // explicitly turns aux off rather than leaving both enabled.
  tile.press(testContext(undefined, { sources: { aux: true, usb: true } }))
  assert.deepEqual(services.calls, ['source:aux:off', 'source:usb:on'])
})

test('a mode tile needs modes to cycle through', () => {
  assert.throws(() => new AudioModeTile(testServices(), { modes: [] }), /at least one mode/)
})
