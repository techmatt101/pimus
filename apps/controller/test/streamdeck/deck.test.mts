import assert from 'node:assert/strict'
import test from 'node:test'

import { createDispatcher, findStreamDeckPlus } from '../../src/streamdeck/deck.mjs'
import type { StreamDeckDeviceInfo } from '@elgato-stream-deck/node'

test('Stream Deck presses are serialized and the Plus model is selected', async () => {
  const observed: string[] = []
  let active = 0
  let maximumActive = 0
  const dispatch = createDispatcher({ error: () => {} })
  const press = (name: string) => async (): Promise<void> => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    observed.push(name)
    active -= 1
  }
  await Promise.all([
    dispatch(press('one')),
    // An empty slot dispatches nothing but must not break the chain.
    dispatch(undefined),
    dispatch(press('two')),
    dispatch(() => { throw new Error('boom') }),
    dispatch(press('three')),
  ])
  assert.equal(maximumActive, 1)
  assert.deepEqual(observed, ['one', 'two', 'three'])

  const devices = [
    { model: 'original', path: '/dev/hidraw0' },
    { model: 'plus', path: '/dev/hidraw1' },
  ] as StreamDeckDeviceInfo[]
  assert.equal(findStreamDeckPlus(devices)?.path, '/dev/hidraw1')
})
