import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {AudioManagerClient} from '../../src/audio/manager-client.mjs'

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2))
    }
    assert.ok(condition())
}

class FakeSocket extends EventEmitter {
    readonly written: string[] = []

    write(value: string): void {
        this.written.push(value)
    }

    destroy(): void {
        this.emit('close')
    }
}

test('route toggles travel over the audio manager socket and survive reconnects', async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-audio-sock-'))
    context.after(() => fs.rmSync(directory, {recursive: true, force: true}))
    const socketPath = path.join(directory, 'audio.sock')
    const received: string[] = []
    const connections: net.Socket[] = []
    const server = net.createServer((connection) => {
        connections.push(connection)
        connection.setEncoding('utf8')
        connection.on('data', (chunk) => received.push(...String(chunk).split('\n').filter(Boolean)))
        connection.on('error', () => {
        })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    context.after(() => server.close())

    let changes = 0
    const client = new AudioManagerClient({
        socketPath,
        reconnectMilliseconds: 1,
        onStateChange: () => {
            changes += 1
        },
        logger: {
            log: () => {
            }, error: () => {
            }
        },
    })
    context.after(() => client.close())
    client.connect()

    // A client with no cache adopts the manager's state.
    await waitFor(() => received.length >= 1)
    assert.deepEqual(JSON.parse(received[0] ?? ''), {command: 'get-state'})
    connections[0]?.write(`${JSON.stringify({event: 'state', sources: {aux: true, usb: false}})}\n`)
    await waitFor(() => client.state.sources.aux === true)

    // Toggles update the cache immediately and send an absolute state.
    client.setSource('usb', 'toggle')
    assert.equal(client.state.sources.usb, true)
    await waitFor(() => received.length >= 2)
    assert.deepEqual(JSON.parse(received[1] ?? ''), {command: 'set-source', name: 'usb', state: 'on'})

    // After a manager restart the client re-asserts its cached toggles.
    const changesBeforeDrop = changes
    connections[0]?.destroy()
    await waitFor(() => received.length >= 3)
    assert.deepEqual(JSON.parse(received[2] ?? ''), {
        command: 'set-sources',
        sources: {aux: true, usb: true},
    })
    assert.ok(changes > changesBeforeDrop)
})

test('toggles before the first state sync defer to the manager', () => {
    const fake = new FakeSocket()
    const client = new AudioManagerClient({
        socketPath: '/nowhere/audio.sock',
        connectSocket: () => fake as unknown as net.Socket,
        logger: {
            log: () => {
            }, error: () => {
            }
        },
    })
    client.connect()
    fake.emit('connect')

    // With no authoritative state yet, an empty cache would resolve any toggle
    // to "on"; the raw command must go to the manager instead.
    client.setSource('aux', 'toggle')
    assert.deepEqual(JSON.parse(fake.written.at(-1) ?? ''), {
        command: 'set-source',
        name: 'aux',
        state: 'toggle',
    })
    assert.deepEqual(client.state, {sources: {}})

    // Once synced, toggles resolve locally and travel as absolute states.
    fake.emit('data', '{"event":"state","sources":{"aux":true}}\n')
    client.setSource('aux', 'toggle')
    assert.deepEqual(JSON.parse(fake.written.at(-1) ?? ''), {
        command: 'set-source',
        name: 'aux',
        state: 'off',
    })
    assert.deepEqual(client.state, {sources: {aux: false}})
    client.close()
})

test('duck requests are deduplicated and re-asserted after a reconnect', async () => {
    const sockets: FakeSocket[] = []
    const client = new AudioManagerClient({
        socketPath: '/nowhere/audio.sock',
        reconnectMilliseconds: 1,
        connectSocket: () => {
            const socket = new FakeSocket()
            sockets.push(socket)
            return socket as unknown as net.Socket
        },
        logger: {
            log: () => {
            }, error: () => {
            }
        },
    })
    client.connect()
    const first = sockets[0]
    assert.ok(first)
    first.emit('connect')

    client.setDuck(true)
    // A repeated request must not put a second message on the socket; the
    // manager holds one request per connection.
    client.setDuck(true)
    assert.deepEqual(
        first.written.map((line) => JSON.parse(line)).filter((message) => message.command === 'set-duck'),
        [{command: 'set-duck', active: true}],
    )

    // The manager releases the request when this socket closes, so a reconnect
    // mid-conversation has to ask again or background audio stays loud.
    first.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = sockets[1]
    assert.ok(second)
    second.emit('connect')
    assert.deepEqual(
        second.written.map((line) => JSON.parse(line)).filter((message) => message.command === 'set-duck'),
        [{command: 'set-duck', active: true}],
    )

    client.setDuck(false)
    assert.deepEqual(JSON.parse(second.written.at(-1) ?? ''), {command: 'set-duck', active: false})
    client.close()
})

test('malformed audio manager events are ignored', () => {
    const fake = new FakeSocket()
    const client = new AudioManagerClient({
        socketPath: '/nowhere/audio.sock',
        connectSocket: () => fake as unknown as net.Socket,
        logger: {
            log: () => {
            }, error: () => {
            }
        },
    })
    client.connect()
    fake.emit('connect')
    fake.emit('data', 'garbage\n{"event":"state","sources":{"aux":true}}\n{"event":"state","sources":null}\n')
    assert.deepEqual(client.state, {sources: {aux: true}, usbHost: false})
    client.close()
})
