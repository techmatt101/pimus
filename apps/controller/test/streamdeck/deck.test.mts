import assert from 'node:assert/strict'
import test from 'node:test'

import { color, createImage } from '../../src/streamdeck/bitmap.mjs'
import { createActionDispatcher, findStreamDeckPlus } from '../../src/streamdeck/deck.mjs'
import type { StreamDeckDeviceInfo } from '@elgato-stream-deck/node'
import type { Action } from '../../src/types.mjs'

test('Stream Deck actions are serialized and the Plus model is selected', async () => {
  const observed: string[] = []
  let active = 0
  let maximumActive = 0
  const dispatch = createActionDispatcher(async (action) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    observed.push(action?.command ?? '')
    active -= 1
  })
  const actions: Action[] = [
    { type: 'audio', command: 'one' },
    { type: 'audio', command: 'two' },
    { type: 'audio', command: 'three' },
  ]
  await Promise.all(actions.map((action) => dispatch(action)))
  assert.equal(maximumActive, 1)
  assert.deepEqual(observed, ['one', 'two', 'three'])

  const devices = [
    { model: 'original', path: '/dev/hidraw0' },
    { model: 'plus', path: '/dev/hidraw1' },
  ] as StreamDeckDeviceInfo[]
  assert.equal(findStreamDeckPlus(devices)?.path, '/dev/hidraw1')
})

test('bitmaps encode colours as deterministic RGB buffers', () => {
  assert.deepEqual(color('#102030'), [16, 32, 48])
  assert.deepEqual([...createImage(1, 1, '#010203').buffer], [1, 2, 3])
})
