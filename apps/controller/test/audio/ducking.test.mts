import assert from 'node:assert/strict'
import test from 'node:test'

import { duckingForEvent, VoiceDucker } from '../../src/audio/ducking.mjs'

test('voice pipeline events duck and safely restore background audio', () => {
  const requests: boolean[] = []
  const ducker = new VoiceDucker({ setDuck: (active) => requests.push(active) })

  assert.equal(duckingForEvent({ event: 'wake_word_detected' }), true)
  assert.equal(duckingForEvent({ event: 'media_player_playing' }), null)
  assert.equal(duckingForEvent({ event: 'tts_finished' }), false)
  assert.equal(duckingForEvent({ event: 'snapshot' }), false)

  ducker.handleEvent({ event: 'listening' })
  ducker.handleEvent({ event: 'thinking' })
  ducker.handleEvent({ event: 'idle' })

  // Only transitions reach the socket; "thinking" follows "listening" and needs
  // no second request.
  assert.deepEqual(requests, [true, false])
  assert.equal(ducker.active, false)
})

test('irrelevant events leave an active duck in place', () => {
  const requests: boolean[] = []
  const ducker = new VoiceDucker({ setDuck: (active) => requests.push(active) })

  ducker.handleEvent({ event: 'tts_speaking' })
  ducker.handleEvent({ event: 'media_player_playing' })
  ducker.handleEvent({ event: 'light_command' })
  assert.equal(ducker.active, true)
  assert.deepEqual(requests, [true])

  ducker.release()
  assert.deepEqual(requests, [true, false])
})
