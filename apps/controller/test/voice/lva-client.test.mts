import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'

import {runVoiceCommand} from '../../src/actions/catalog.mjs'
import {applyLvaEvent, createState} from '../../src/state.mjs'
import {LvaClient} from '../../src/voice/lva-client.mjs'
import type WebSocket from 'ws'

test('the voice key starts a pipeline and cancels one at any phase', () => {
    const sent: string[] = []
    const lva = {
        send: (command: string) => {
            sent.push(command)
            return true
        },
    }
    const state = createState({assist: 'IDLE'})
    const toggle = (): void => runVoiceCommand('listen_toggle', {state, lva})
    const move = (event: string): void => {
        applyLvaEvent(state, {event})
    }

    toggle()
    for (const event of ['wake_word_detected', 'listening', 'thinking', 'tts_speaking']) {
        move(event)
        toggle()
    }
    // A ringing timer belongs to the timer key, so this one still just listens.
    move('timer_ringing')
    toggle()
    move('idle')
    toggle()

    assert.deepEqual(sent, [
        'start_listening',
        'stop_pipeline',
        'stop_pipeline',
        'stop_pipeline',
        'stop_pipeline',
        'start_listening',
        'start_listening',
    ])
})

class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1
    static readonly instances: FakeWebSocket[] = []
    readonly sent: string[] = []
    readyState = FakeWebSocket.OPEN

    constructor(readonly uri: string) {
        super()
        FakeWebSocket.instances.push(this)
    }

    send(value: string): void {
        this.sent.push(value)
    }
}

const quiet = {
    log: () => {
    }, error: () => {
    },
}

test('LVA client sends commands, applies events, and reconnects after close', async () => {
    const state = createState()
    let opened = 0
    let disconnected = 0
    let changed = 0
    const client = new LvaClient({
        uri: 'ws://127.0.0.1:6055',
        state,
        reconnectMilliseconds: 0,
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onOpen: () => {
            opened += 1
        },
        onDisconnect: () => {
            disconnected += 1
        },
        onStateChange: () => {
            changed += 1
        },
        logger: quiet,
    })

    client.connect()
    const first = FakeWebSocket.instances[0]
    assert.ok(first)
    first.emit('open')
    assert.equal(opened, 1)
    assert.equal(client.send('set_volume', {volume: 0.5}), true)
    assert.deepEqual(JSON.parse(first.sent[0] ?? ''), {
        command: 'set_volume',
        data: {volume: 0.5},
    })
    first.emit('message', Buffer.from(JSON.stringify({event: 'muted', data: {muted: true}})))
    assert.equal(state.muted, true)

    first.emit('close')
    assert.equal(state.assist, 'DISCONNECTED')
    assert.equal(disconnected, 1)
    assert.equal(changed, 2)
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(FakeWebSocket.instances.length, 2)
})

test('the end of a reply is held back until the audio has played out', async () => {
    const state = createState({assist: 'IDLE'})
    const events: string[] = []
    const client = new LvaClient({
        uri: 'ws://127.0.0.1:6055',
        state,
        playoutMilliseconds: 30,
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: (message) => {
            events.push(String(message.event))
        },
        logger: quiet,
    })

    client.connect()
    const socket = FakeWebSocket.instances.at(-1)
    assert.ok(socket)
    socket.emit('open')
    const deliver = (event: string): void => {
        socket.emit('message', Buffer.from(JSON.stringify({event})))
    }
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

    // LVA reports the reply finished an output buffer before the last of it is
    // heard, so the ring, the voice key, and the duck all stay speaking until
    // the sound has caught up.
    deliver('tts_speaking')
    deliver('tts_finished')
    deliver('idle')
    assert.equal(state.assist, 'TTS_SPEAKING')
    assert.deepEqual(events, ['tts_speaking'])
    await settle()
    assert.equal(state.assist, 'IDLE')
    assert.deepEqual(events, ['tts_speaking', 'idle'])

    // A pipeline that has already moved on abandons the ending it was holding.
    deliver('tts_speaking')
    deliver('tts_finished')
    deliver('wake_word_detected')
    await settle()
    assert.equal(state.assist, 'WAKE_WORD_DETECTED')

    // Cancelling stops the player outright rather than letting it run out, so
    // that ending is the truth and lands at once.
    deliver('tts_speaking')
    client.send('stop_pipeline')
    deliver('idle')
    assert.equal(state.assist, 'IDLE')

    // That exemption belongs to the reply it stopped, and not to the next one.
    deliver('tts_speaking')
    deliver('tts_finished')
    assert.equal(state.assist, 'TTS_SPEAKING')
    await settle()
    assert.equal(state.assist, 'IDLE')
})
