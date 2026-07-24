import assert from 'node:assert/strict'
import test from 'node:test'

import { VolumeDial } from '../../../src/streamdeck/dials/volume-dial.mjs'
import { DialScreen } from '../../../src/streamdeck/screens/dial-screen.mjs'
import { screenFace, testServices } from '../../support/fixtures.mjs'
import type { Dial } from '../../../src/streamdeck/dials/dial.mjs'

test('the dial face shows the dial the strip handed it, and its level', () => {
  const services = testServices()
  const screen = new DialScreen(services.clock)
  const dial = new VolumeDial(services)
  screen.show(dial)

  services.model.state.volume = 0.2
  const quiet = screenFace(screen)
  services.model.state.volume = 0.9
  const loud = screenFace(screen)
  assert.deepEqual([quiet.width, quiet.height], [800, 100], 'the readout takes the whole strip')
  assert.notDeepEqual(quiet.buffer, loud.buffer, 'the reading and its bar follow the volume')

  // A screen never handed a dial has nothing to report, and nothing is drawn.
  const blank = screenFace(new DialScreen(services.clock))
  assert.notDeepEqual(blank.buffer, quiet.buffer)
})

test('a dial with no level to plot gets a readout and no bar', () => {
  const services = testServices()
  const level: Dial = { label: 'LIGHTS', detail: () => '60%', level: () => 0.6 }
  const plain: Dial = { label: 'LIGHTS', detail: () => '60%' }

  const withBar = new DialScreen(services.clock)
  withBar.show(level)
  const withoutBar = new DialScreen(services.clock)
  withoutBar.show(plain)

  // Same label and same reading, so the bar is the only thing that can differ.
  assert.notDeepEqual(screenFace(withBar).buffer, screenFace(withoutBar).buffer)
})
