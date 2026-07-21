import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../../src/state.mjs'
import { MediaTile } from '../../../src/streamdeck/tiles/media-tile.mjs'
import { eventually, testContext, testHost, testServices } from '../../support/fixtures.mjs'
import type { TileContext } from '../../../src/streamdeck/tiles/tile.mjs'
import type { ControlState } from '../../../src/types.mjs'

const services = testServices

const context = (state: ControlState, now = 0): TileContext => testContext(state, { now })

test('the media tile is one play/pause button that toggles the player itself', () => {
  const state = createState({ media: false })
  const deps = services(state)
  const tile = new MediaTile(deps)
  assert.deepEqual(tile.action(), { type: 'lva', command: 'media_toggle' })

  // Pressing runs the media toggle directly: the LVA command matches the
  // playback state, which flips immediately so the key repaints without
  // waiting for LVA's confirming event.
  tile.press()
  assert.deepEqual(deps.calls, ['lva:resume_media_player'])
  assert.equal(state.media, true)
  tile.press()
  assert.deepEqual(deps.calls, ['lva:resume_media_player', 'lva:pause_media_player'])
  assert.equal(state.media, false)
})

test('the playing face pulses: it varies with time, the paused face does not', () => {
  const tile = new MediaTile(services())
  const playing = createState({ media: true })
  assert.notDeepEqual(
    tile.render(context(playing, 0)).buffer,
    tile.render(context(playing, 300)).buffer,
    'the pause bars breathe while playing',
  )

  const paused = createState({ media: false })
  assert.deepEqual(
    tile.render(context(paused, 0)).buffer,
    tile.render(context(paused, 300)).buffer,
    'the resting face is steady',
  )
  assert.notDeepEqual(
    tile.render(context(playing, 0)).buffer,
    tile.render(context(paused, 0)).buffer,
    'the play and pause faces differ',
  )
})

test('while mounted, the tile follows playback from the model and animates itself', async () => {
  const state = createState({ media: false })
  const deps = services(state)
  const tile = new MediaTile(deps)

  const host = testHost()
  tile.mount(host)
  assert.equal(host.repaints, 0, 'no animation while paused')

  // Playback starting anywhere (LVA, another key) reaches this tile through
  // the model subscription and starts the pulse timer.
  state.media = true
  deps.model.notify()
  await eventually(() => host.repaints >= 2)

  // Pausing stops the pulse: cleared timers are guaranteed never to fire.
  state.media = false
  deps.model.notify()
  const settled = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.repaints, settled, 'no repaints after the pulse stops')

  // Unmounting drops the model subscription, so playback no longer restarts it.
  tile.unmount()
  state.media = true
  deps.model.notify()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.repaints, settled, 'an unmounted tile is inert')
})
