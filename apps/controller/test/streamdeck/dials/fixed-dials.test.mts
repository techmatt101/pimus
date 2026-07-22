import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../../src/state.mjs'
import { ActionDial } from '../../../src/streamdeck/dials/action-dial.mjs'
import { MediaDial } from '../../../src/streamdeck/dials/media-dial.mjs'
import { VolumeDial } from '../../../src/streamdeck/dials/volume-dial.mjs'
import { testContext, testServices } from '../../support/fixtures.mjs'

const PLAYER = 'media_player.office'

test('the volume dial turns the output and reads it back', () => {
  const services = testServices()
  const dial = new VolumeDial(services)

  dial.left.run()
  dial.right.run()
  dial.press.run()
  assert.deepEqual(services.calls, ['volume:down', 'volume:up', 'volume:mute'])

  assert.equal(dial.detail(testContext(createState({ volume: 0.67 }))), '67%')
  assert.equal(dial.level(testContext(createState({ volume: 0.4 }))), 0.4)

  // Muted is its own reading, and an empty bar: the level to come back to is
  // still the level the deck remembers.
  const muted = testContext(createState({ volume: 0.4, outputMuted: true }))
  assert.equal(dial.detail(muted), 'MUTED')
  assert.equal(dial.level(muted), 0)
})

test('the media dial skips through the player and plays through the voice assistant', () => {
  const services = testServices()
  const dial = new MediaDial(services, { player: PLAYER })

  dial.left.run()
  dial.right.run()
  dial.press.run()
  assert.deepEqual(services.ha.calls, [
    `media_player.media_previous_track ${PLAYER}`,
    `media_player.media_next_track ${PLAYER}`,
  ])
  // Play/pause stays on LVA, which is where the playback state comes from, and
  // the catalog picks the direction from the state the controller holds.
  assert.deepEqual(services.calls, ['lva:resume_media_player'])

  const state = createState()
  assert.equal(dial.detail(testContext(state)), 'PAUSED')
  state.media = true
  assert.equal(dial.detail(testContext(state)), 'PLAYING')
  // Nothing to plot: a transport position is not a level the knob sets.
  assert.equal('level' in dial, false)
})

test('a dial bound to nothing says so rather than reading as broken', () => {
  const spare = new ActionDial({ label: 'SPARE', readout: 'NOT IN USE' })

  assert.equal(spare.detail(testContext()), 'NOT IN USE')
  assert.equal(spare.level(testContext()), undefined)
  assert.equal(spare.left, undefined)
  assert.equal(spare.right, undefined)
  assert.equal(spare.press, undefined)
})

test('an action dial can derive its readout and its bar from live state', () => {
  const dial = new ActionDial({
    label: 'VOLUME',
    readout: ({ state }) => `${Math.round(state.volume * 100)}%`,
    level: ({ state }) => state.volume,
  })

  assert.equal(dial.detail(testContext(createState({ volume: 0.25 }))), '25%')
  assert.equal(dial.level(testContext(createState({ volume: 0.25 }))), 0.25)
})
