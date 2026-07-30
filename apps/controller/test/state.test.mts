import assert from 'node:assert/strict'
import test from 'node:test'

import {applyLvaEvent, ControlModel, createState} from '../src/state.mjs'

test('LVA snapshots and events update shared display state', () => {
    const state = createState()
    applyLvaEvent(state, {event: 'snapshot', data: {muted: true, volume: 0.42, ha_connected: true}})
    assert.deepEqual(state, {
        assist: 'IDLE',
        // A connection that replays no timer is one with no timer running.
        timer: null,
        muted: true,
        volume: 0.42,
        outputMuted: false,
        media: false,
        // A voice event says nothing about whether anybody is in the room.
        panel: 'lit',
        // Nor about the panel brightness, which the deck owns.
        brightness: 40,
        // Nor about subsystem health, which the health monitor owns.
        health: {network: true, ha: true, audio: true, usbPlayback: false},
    })

    applyLvaEvent(state, {event: 'wake_word_detected'})
    assert.equal(state.assist, 'WAKE_WORD_DETECTED')
    applyLvaEvent(state, {event: 'media_player_playing'})
    assert.equal(state.media, true)
    applyLvaEvent(state, {event: 'media_player_paused'})
    assert.equal(state.media, false)
    applyLvaEvent(state, {event: 'volume_changed', data: {volume: 0.8}})
    assert.equal(state.volume, 0.8)
    applyLvaEvent(state, {event: 'volume_changed'})
    assert.equal(state.volume, 0.8)
})

test('non-pipeline events leave the assist display state alone', () => {
    const state = createState({assist: 'LISTENING'})
    applyLvaEvent(state, {event: 'light_command'})
    applyLvaEvent(state, {event: 'zeroconf', data: {status: 'connected'}})
    assert.equal(state.assist, 'LISTENING')
    applyLvaEvent(state, {event: 'timer_ticking'})
    assert.equal(state.assist, 'TIMER_TICKING')
    state.assist = 'LISTENING'
    applyLvaEvent(state, {event: 'timer_updated'})
    assert.equal(state.assist, 'TIMER_TICKING')
})

test('an assistant timer survives an unrelated pipeline and ends when it is done', () => {
    const state = createState({assist: 'IDLE'})
    const now = 1_000_000
    const ticking = {
        event: 'timer_ticking',
        data: {id: 'a', name: 'pasta', total_seconds: 300, seconds_left: 300, is_active: true, emitted_at: (now - 4000) / 1000},
    }

    applyLvaEvent(state, ticking, now)
    // The reading was taken four seconds before it arrived, and the countdown
    // is measured from then, not from now.
    assert.deepEqual(state.timer, {
        id: 'a',
        name: 'pasta',
        totalSeconds: 300,
        secondsLeft: 300,
        endsAt: now - 4000 + 300_000,
        active: true,
        ringing: false,
    })

    // A voice command run while it ticks ends with an idle of its own.
    applyLvaEvent(state, {event: 'tts_speaking'}, now)
    applyLvaEvent(state, {event: 'idle'}, now)
    assert.equal(state.timer?.id, 'a')

    applyLvaEvent(state, {event: 'timer_updated', data: {...ticking.data, seconds_left: 120, is_active: false}}, now)
    assert.equal(state.timer?.active, false)
    assert.equal(state.timer?.secondsLeft, 120)

    applyLvaEvent(state, {event: 'timer_ringing', data: {...ticking.data, seconds_left: 0}}, now)
    assert.equal(state.timer?.ringing, true)
    applyLvaEvent(state, {event: 'idle'}, now)
    assert.equal(state.timer, null)

    applyLvaEvent(state, ticking, now)
    applyLvaEvent(state, {event: 'timer_cancelled'}, now)
    assert.equal(state.timer, null)
})

test('the control model notifies subscribers until they unsubscribe', () => {
    const model = new ControlModel(createState(), () => ({sources: {aux: true}, routesKnown: true}))
    assert.deepEqual(model.audio, {sources: {aux: true}, routesKnown: true})

    let seen = 0
    const unsubscribe = model.subscribe(() => {
        seen += 1
    })
    model.notify()
    model.notify()
    unsubscribe()
    model.notify()
    assert.equal(seen, 2)

    // A listener that unsubscribes while being notified must not break others.
    let other = 0
    const stopEarly = model.subscribe(() => stopEarly())
    model.subscribe(() => {
        other += 1
    })
    model.notify()
    assert.equal(other, 1)
})
