import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../../src/state.mjs'
import { VolumeDial } from '../../../src/streamdeck/dials/volume-dial.mjs'
import { DialScreen } from '../../../src/streamdeck/screens/dial-screen.mjs'
import { screenFace, testContext, testServices } from '../../support/fixtures.mjs'
import type { Dial } from '../../../src/streamdeck/dials/dial.mjs'

test('the dial face shows the dial the strip handed it, and its level', () => {
  const screen = new DialScreen()
  const dial = new VolumeDial(testServices())

  const quiet = screenFace(screen, { ...testContext(createState({ volume: 0.2 })), dial })
  const loud = screenFace(screen, { ...testContext(createState({ volume: 0.9 })), dial })
  assert.deepEqual([quiet.width, quiet.height], [800, 100], 'the readout takes the whole strip')
  assert.notDeepEqual(quiet.buffer, loud.buffer, 'the reading and its bar follow the volume')

  // With no dial selected there is nothing to report, and nothing is drawn.
  const blank = screenFace(screen, testContext())
  assert.notDeepEqual(blank.buffer, quiet.buffer)
})

test('a dial with no level to plot gets a readout and no bar', () => {
  const screen = new DialScreen()
  const level: Dial = { label: 'LIGHTS', detail: () => '60%', level: () => 0.6 }
  const plain: Dial = { label: 'LIGHTS', detail: () => '60%' }

  // Same label and same reading, so the bar is the only thing that can differ.
  assert.notDeepEqual(
    screenFace(screen, { ...testContext(), dial: level }).buffer,
    screenFace(screen, { ...testContext(), dial: plain }).buffer,
  )
})
