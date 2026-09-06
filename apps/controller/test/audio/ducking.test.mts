import assert from 'node:assert/strict'
import test from 'node:test'

import {duckChangeForEvent, VoiceDucker} from '../../src/audio/ducking.mjs'

test('voice pipeline events duck and safely restore the music', () => {
    const requests: boolean[] = []
    const ducker = new VoiceDucker({setDuck: (active) => requests.push(active)})

    assert.deepEqual(duckChangeForEvent({event: 'wake_word_detected'}), {voice: true})
    assert.deepEqual(duckChangeForEvent({event: 'media_player_playing'}), {media: true})
    assert.deepEqual(duckChangeForEvent({event: 'tts_finished'}), {voice: false})
    assert.deepEqual(duckChangeForEvent({event: 'snapshot'}), {voice: false, media: false})
    assert.equal(duckChangeForEvent({event: 'light_command'}), null)

    ducker.handleEvent({event: 'listening'})
    ducker.handleEvent({event: 'thinking'})
    ducker.handleEvent({event: 'idle'})

    // Only transitions reach the socket; "thinking" follows "listening" and needs
    // no second request.
    assert.deepEqual(requests, [true, false])
    assert.equal(ducker.active, false)
})

test('irrelevant events leave an active duck in place', () => {
    const requests: boolean[] = []
    const ducker = new VoiceDucker({setDuck: (active) => requests.push(active)})

    ducker.handleEvent({event: 'tts_speaking'})
    ducker.handleEvent({event: 'light_command'})
    assert.equal(ducker.active, true)
    assert.deepEqual(requests, [true])

    ducker.release()
    assert.deepEqual(requests, [true, false])
})

test("the assistant's media player ducks on its own, apart from the pipeline", () => {
    const requests: boolean[] = []
    const ducker = new VoiceDucker({setDuck: (active) => requests.push(active)})

    // A clip played over the assistant's media player ducks like a reply.
    ducker.handleEvent({event: 'media_player_playing'})
    assert.deepEqual(requests, [true])
    ducker.handleEvent({event: 'media_player_idle'})
    assert.deepEqual(requests, [true, false])

    // A reply ending under a clip, or a clip ending under a reply, restores
    // nothing until both are over.
    ducker.handleEvent({event: 'media_player_playing'})
    ducker.handleEvent({event: 'tts_speaking'})
    ducker.handleEvent({event: 'tts_finished'})
    assert.equal(ducker.active, true)
    ducker.handleEvent({event: 'media_player_paused'})
    assert.equal(ducker.active, false)
    assert.deepEqual(requests, [true, false, true, false])

    // A reconnect replays the state from scratch, so the snapshot clears both.
    ducker.handleEvent({event: 'media_player_playing'})
    ducker.handleEvent({event: 'snapshot'})
    assert.equal(ducker.active, false)
})
