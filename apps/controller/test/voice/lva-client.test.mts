import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'

import {runVoiceCommand} from '../../src/actions/catalog.mjs'
import {applyLvaEvent, createState} from '../../src/state.mjs'
import {LvaClient} from '../../src/voice/lva-client.mjs'
import type WebSocket from 'ws'

test('the voice key starts a pipeline and cancels whatever voice is doing', () => {
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
        'stop_pipeline',
        'start_listening',
    ])
})

test('LVA client sends commands, applies events, and reconnects after close', async () => {
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
        logger: {
            log: () => {
            }, error: () => {
            }
        },
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
