// The keys that drive playback and the voice pipeline: shuffle, the playlist
// shortcut, the scene cycle, and the listen/cancel key.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../../src/state.mjs'
import { PlaylistTile } from '../../../src/streamdeck/tiles/playlist-tile.mjs'
import { SceneTile } from '../../../src/streamdeck/tiles/scene-tile.mjs'
import { ShuffleTile } from '../../../src/streamdeck/tiles/shuffle-tile.mjs'
import { VoiceTile } from '../../../src/streamdeck/tiles/voice-tile.mjs'
import { eventually, testHost, testServices, tileFace } from '../../support/fixtures.mjs'

const PLAYER = 'media_player.office_amp'

test('shuffle asks for the opposite of what the player reports', () => {
  const services = testServices()
  const tile = new ShuffleTile(services, PLAYER)

  services.ha.put(PLAYER, 'playing', { shuffle: false })
  tile.press()
  services.ha.put(PLAYER, 'playing', { shuffle: true })
  tile.press()

  assert.deepEqual(services.ha.calls, [
    `media_player.shuffle_set ${PLAYER} {"shuffle":true}`,
    `media_player.shuffle_set ${PLAYER} {"shuffle":false}`,
  ])
})

test('the shuffle face separates on, off, and an unreachable player', () => {
  const services = testServices()
  const tile = new ShuffleTile(services, PLAYER)

  const unknown = tileFace(tile)
  services.ha.put(PLAYER, 'playing', { shuffle: false })
  const off = tileFace(tile)
  services.ha.put(PLAYER, 'playing', { shuffle: true })
  const on = tileFace(tile)

  assert.notDeepEqual(on, off)
  assert.notDeepEqual(unknown, off)
})

test('a playlist key sends its compiled-in media id to its player', () => {
  const services = testServices()
  const tile = new PlaylistTile(services, {
    label: 'FOCUS',
    player: PLAYER,
    media: { media_content_id: 'library://playlist/1', media_content_type: 'playlist' },
  })

  assert.deepEqual(tile.action(), {
    type: 'ha',
    command: 'play_media',
    entity: PLAYER,
    data: { media_content_id: 'library://playlist/1', media_content_type: 'playlist' },
  })
  tile.press()
  assert.deepEqual(services.ha.calls, [
    `media_player.play_media ${PLAYER} {"media_content_id":"library://playlist/1","media_content_type":"playlist"}`,
  ])

  // The key lights up with its player's own state; it cannot tell whether this
  // particular playlist is the thing playing.
  const idle = tileFace(tile)
  services.ha.put(PLAYER, 'playing', {})
  assert.notDeepEqual(tileFace(tile), idle)
})

test('a scene key steps through its scenes and wraps around', () => {
  const services = testServices()
  const tile = new SceneTile(services, {
    scenes: [
      { label: 'BRIGHT', entity: 'scene.office_bright' },
      { label: 'WARM', entity: 'scene.office_warm' },
    ],
  })

  const resting = tileFace(tile)
  tile.press()
  tile.press()
  tile.press()

  assert.deepEqual(services.ha.calls, [
    'scene.turn_on scene.office_bright',
    'scene.turn_on scene.office_warm',
    'scene.turn_on scene.office_bright',
  ])

  // Before the first press the key previews the first scene rather than
  // claiming it is applied — the room may have been set from somewhere else.
  assert.notDeepEqual(tileFace(tile), resting)
})

test('a scene tile needs scenes, and checks every entity id it holds', () => {
  assert.throws(() => new SceneTile(testServices(), { scenes: [] }), /at least one scene/)
  assert.throws(
    () => new SceneTile(testServices(), {
      scenes: [{ label: 'OK', entity: 'scene.good' }, { label: 'BAD', entity: 'scene..bad' }],
    }),
    /not a Home Assistant entity id/,
    'the second scene is checked even though the first is fine',
  )
})

test('the voice key starts a pipeline, then cancels the one it started', () => {
  const state = createState()
  const services = testServices(state)
  const tile = new VoiceTile(services)
  assert.deepEqual(tile.action(), { type: 'lva', command: 'listen_toggle' })

  tile.press()
  state.assist = 'LISTENING'
  tile.press()

  assert.deepEqual(services.calls, ['lva:start_listening', 'lva:stop_pipeline'])
})

test('the voice key ripples while a pipeline runs and stops when it ends', async () => {
  const state = createState()
  const services = testServices(state)
  const tile = new VoiceTile(services)

  const idle = tileFace(tile)
  state.assist = 'LISTENING'
  // The ripple accumulates the deltaTime each draw is handed, so two draws a
  // step apart sweep the rings outwards.
  const listening = tileFace(tile, 0)
  assert.notDeepEqual(idle, listening)
  assert.notDeepEqual(listening, tileFace(tile, 400), 'the rings sweep outwards')

  state.assist = 'IDLE'
  const host = testHost()
  tile.mount(host)
  assert.equal(host.repaints, 0, 'no animation while idle')

  // A pipeline started by the wake word rather than this key still animates it.
  state.assist = 'THINKING'
  services.model.notify()
  await eventually(() => host.repaints >= 2)

  state.assist = 'IDLE'
  services.model.notify()
  const settled = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.repaints, settled)

  tile.unmount()
  state.assist = 'LISTENING'
  services.model.notify()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.repaints, settled, 'an unmounted tile is inert')
})
