import assert from 'node:assert/strict'
import test from 'node:test'

import {applyLvaEvent, ControlModel, createState} from '../src/state.mjs'

test('LVA snapshots and events update shared display state', () => {
    const state = createState()
    applyLvaEvent(state, {event: 'snapshot', data: {muted: true, volume: 0.42, ha_connected: true}})
    assert.deepEqual(state, {
        assist: 'IDLE',
        muted: true,
        volume: 0.42,
        outputMuted: false,
        media: false,
        // A voice event says nothing about whether anybody is in the room.
        awake: true,
        // Nor about the panel brightness, which the deck owns.
        brightness: 40,
        // Nor about subsystem health, which the health monitor owns.
        health: {network: true, ha: true, audio: true, usbHost: false},
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

test('the control model notifies subscribers until they unsubscribe', () => {
    const model = new ControlModel(createState(), () => ({sources: {aux: true}}))
    assert.deepEqual(model.audio, {sources: {aux: true}})

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
