import assert from 'node:assert/strict'
import test from 'node:test'

import { NowPlayingScreen, nowPlayingLines } from '../../../src/streamdeck/screens/now-playing-screen.mjs'
import { screenFace, testScreenHost, testServices } from '../../support/fixtures.mjs'

const PLAYER = 'media_player.office_amp'

const playing = {
  state: 'playing',
  attributes: {
    media_title: 'Teardrop',
    media_artist: 'Massive Attack',
    media_duration: 330,
    media_position: 30,
    // The position is reported once, with the instant it was measured; the epoch
    // keeps the derived elapsed time the same on every machine.
    media_position_updated_at: new Date(0).toISOString(),
  },
}

test('the resting face reports the track, who it is by, and whether it is paused', () => {
  assert.deepEqual(
    nowPlayingLines({ entity_id: PLAYER, ...playing }, true),
    { title: 'Teardrop', secondary: 'Massive Attack', idle: false },
  )

  // Paused is said in words: the strip is the only place playback state shows
  // while the deck is on a page without the media key.
  assert.deepEqual(
    nowPlayingLines({ entity_id: PLAYER, ...playing, state: 'paused' }, true).secondary,
    'PAUSED - Massive Attack',
  )

  // A player with nothing queued, and a Home Assistant that cannot be reached,
  // must not look the same: an unreachable house is not a quiet room.
  assert.deepEqual(nowPlayingLines({ entity_id: PLAYER, state: 'idle', attributes: {} }, true), {
    title: 'NOTHING PLAYING',
    secondary: '',
    idle: true,
  })
  assert.equal(nowPlayingLines(undefined, true).title, 'NO MEDIA INFO')
  assert.equal(nowPlayingLines({ entity_id: PLAYER, ...playing }, false).title, 'NO MEDIA INFO')
})

test('the face follows the player and fills the strip', () => {
  const services = testServices()
  const screen = new NowPlayingScreen(services, { player: PLAYER })

  const nothing = screenFace(screen)
  assert.deepEqual([nothing.width, nothing.height], [800, 100])

  services.ha.put(PLAYER, playing.state, playing.attributes)
  const track = screenFace(screen)
  assert.notDeepEqual(track.buffer, nothing.buffer)

  // The position bar moves with the clock while the player is playing, so the
  // face is not static even when nothing about the entity changed.
  services.setNow(60_000)
  const later = screenFace(screen)
  assert.notDeepEqual(track.buffer, later.buffer)

  services.ha.put(PLAYER, 'paused', playing.attributes)
  assert.notDeepEqual(screenFace(screen), track.buffer, 'paused reads differently')
})

test('a title too wide for the strip scrolls, and a short one sits still', () => {
  const services = testServices()
  const screen = new NowPlayingScreen(services, { player: PLAYER })

  services.ha.put(PLAYER, 'playing', { media_title: 'Teardrop', media_artist: 'Massive Attack' })
  assert.equal(screen.animationMilliseconds(), undefined, 'a short title needs no frames')
  services.setNow(0)
  const stillA = screenFace(screen)
  services.setNow(400)
  assert.deepEqual(stillA, screenFace(screen))

  services.ha.put(PLAYER, 'playing', {
    media_title: 'Everything In Its Right Place (Remastered Extended Album Version)',
    media_artist: 'Radiohead',
  })
  assert.ok((screen.animationMilliseconds() ?? 0) > 0, 'a long title asks for frames')
  services.setNow(0)
  const slideA = screenFace(screen)
  services.setNow(400)
  assert.notDeepEqual(slideA, screenFace(screen), 'the title slides across the strip')
})

test('a playing track ticks so its position bar creeps forward', () => {
  const services = testServices()
  const screen = new NowPlayingScreen(services, { player: PLAYER })

  services.ha.put(PLAYER, 'playing', playing.attributes)
  assert.equal(screen.animationMilliseconds(), 1000, 'the bar moves although nothing reports it moving')

  // A paused track holds its position, and a stream that reports none has no
  // bar to move, so neither costs the deck a repaint every second.
  services.ha.put(PLAYER, 'paused', playing.attributes)
  assert.equal(screen.animationMilliseconds(), undefined)
  services.ha.put(PLAYER, 'playing', { media_title: 'BBC Radio 6', media_artist: 'Live' })
  assert.equal(screen.animationMilliseconds(), undefined)
})

test('the screen watches the player only while it is mounted', () => {
  const services = testServices()
  const screen = new NowPlayingScreen(services, { player: PLAYER })
  const host = testScreenHost()

  screen.mount(host)
  assert.equal(services.ha.watchCount, 1)
  services.ha.put(PLAYER, 'playing', { media_title: 'Teardrop' })
  assert.equal(host.repaints, 1, 'a track change repaints the strip')

  screen.unmount()
  assert.equal(services.ha.watchCount, 0)
  services.ha.put(PLAYER, 'playing', { media_title: 'Angel' })
  assert.equal(host.repaints, 1, 'a hidden strip is not repainted')
})

test('the player entity id is checked where the screen is built', () => {
  assert.throws(
    () => new NowPlayingScreen(testServices(), { player: 'office amp' }),
    /not a Home Assistant entity id/,
  )
})
