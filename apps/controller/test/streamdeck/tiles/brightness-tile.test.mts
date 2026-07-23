import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../../src/state.mjs'
import { BrightnessTile } from '../../../src/streamdeck/tiles/brightness-tile.mjs'
import { testContext, testServices, tileFace } from '../../support/fixtures.mjs'

test('a press steps to the next level and notifies, cycling round from the top', () => {
  const state = createState() // starts at the default 40
  const services = testServices(state)
  const tile = new BrightnessTile(services, { levels: [20, 40, 70, 100] })

  let notifications = 0
  services.model.subscribe(() => { notifications += 1 })

  tile.press()
  assert.equal(state.brightness, 70, 'steps on from the level nearest 40')
  assert.equal(notifications, 1, 'the press notifies so the renderer re-lights')

  tile.press()
  assert.equal(state.brightness, 100)

  tile.press()
  assert.equal(state.brightness, 20, 'the top wraps back to the lowest level')
})

test('a press steps on from the level nearest the current brightness', () => {
  // Set from elsewhere (the sleep controller, a restart) between two levels.
  const state = createState({ brightness: 60 })
  const services = testServices(state)
  const tile = new BrightnessTile(services, { levels: [20, 40, 70, 100] })

  tile.press()
  assert.equal(state.brightness, 100, '60 is nearest 70, so a press goes to 100')
})

test('the face reads the current level and a tile needs at least one', () => {
  const tile = new BrightnessTile(testServices(), { levels: [20, 40, 70, 100] })

  const low = tileFace(tile, testContext(createState({ brightness: 20 })))
  const high = tileFace(tile, testContext(createState({ brightness: 100 })))
  assert.notDeepEqual(low.buffer, high.buffer, 'a different level draws a different face')

  assert.throws(() => new BrightnessTile(testServices(), { levels: [] }), /at least one level/)
})
