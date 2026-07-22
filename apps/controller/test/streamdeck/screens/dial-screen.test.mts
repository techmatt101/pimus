import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../../src/state.mjs'
import type { Binding } from '../../../src/streamdeck/bindings.mjs'
import { DialScreen, dialDetail, dialLevel } from '../../../src/streamdeck/screens/dial-screen.mjs'
import { screenFace, testContext } from '../../support/fixtures.mjs'
import type { Action } from '../../../src/types.mjs'

/** A dial binding whose behaviour is irrelevant; only its action is read. */
const bound = (action: Action): Binding => ({ action, run: () => {} })

test('dial readouts follow their bound actions rather than dial position', () => {
  const state = createState({ volume: 0.67 })
  const volumeDial = {
    label: 'VOLUME',
    left: bound({ type: 'audio', command: 'down' }),
    right: bound({ type: 'audio', command: 'up' }),
    press: bound({ type: 'audio', command: 'mute' }),
  }

  // The volume dial reports volume wherever it sits in the layout.
  assert.equal(dialDetail(testContext(state), volumeDial), '67%')
  state.outputMuted = true
  assert.equal(dialDetail(testContext(state), volumeDial), 'MUTED')

  assert.equal(dialDetail(testContext(state, { sources: { aux: true } }), {
    label: 'AUX',
    press: bound({ type: 'audio', source: 'aux', command: 'toggle' }),
  }), 'ON')
  assert.equal(dialDetail(testContext(state, { sources: { usb: false } }), {
    label: 'USB',
    left: bound({ type: 'audio', source: 'usb', command: 'off' }),
  }), 'OFF')

  // A dial bound to neither volume nor a route falls back to the assist state.
  assert.equal(dialDetail(testContext(createState({ assist: 'LISTENING' })), {
    label: 'VOICE',
    press: bound({ type: 'lva', command: 'start_listening' }),
  }), 'LISTENING')
})

test('a dial that supplies its own readout wins over the bound actions', () => {
  // A light dial is bound to `ha` actions the shared readout cannot interpret,
  // so it reports brightness itself — the dial equivalent of a tile drawing its
  // own face.
  const lights = {
    label: 'LIGHTS',
    press: bound({ type: 'ha', command: 'toggle', entity: 'light.office' }),
    detail: () => '60%',
  }
  assert.equal(dialDetail(testContext(), lights), '60%')

  // An own readout also overrides one the actions would have produced.
  assert.equal(dialDetail(testContext(createState({ volume: 0.2 })), {
    ...lights,
    left: bound({ type: 'audio', command: 'down' }),
  }), '60%')
})

test('the bar under the readout is drawn only for a dial whose value is a level', () => {
  const volumeDial = { label: 'VOLUME', right: bound({ type: 'audio', command: 'up' }) }
  assert.equal(dialLevel(testContext(createState({ volume: 0.4 })), volumeDial), 0.4)
  // Muted is empty rather than "wherever the slider happens to sit".
  assert.equal(dialLevel(testContext(createState({ volume: 0.4, outputMuted: true })), volumeDial), 0)

  // A route or voice dial has no level, so its readout gets no bar at all.
  assert.equal(dialLevel(testContext(), { label: 'VOICE', press: bound({ type: 'lva', command: 'stop' }) }), undefined)
  assert.equal(dialLevel(testContext(), {
    label: 'LIGHTS',
    press: bound({ type: 'ha', command: 'toggle', entity: 'light.office' }),
    level: () => 0.75,
  }), 0.75)
})

test('the dial face shows the dial the strip handed it, and its level', () => {
  const screen = new DialScreen()
  const dial = {
    label: 'VOLUME',
    left: bound({ type: 'audio', command: 'down' }),
    right: bound({ type: 'audio', command: 'up' }),
  }
  const quiet = screenFace(screen, { ...testContext(createState({ volume: 0.2 })), dial })
  const loud = screenFace(screen, { ...testContext(createState({ volume: 0.9 })), dial })
  assert.deepEqual([quiet.width, quiet.height], [800, 100], 'the readout takes the whole strip')
  assert.notDeepEqual(quiet.buffer, loud.buffer, 'the reading and its bar follow the volume')

  // With no dial selected there is nothing to report, and nothing is drawn.
  const blank = screenFace(screen, testContext())
  assert.notDeepEqual(blank.buffer, quiet.buffer)
})
