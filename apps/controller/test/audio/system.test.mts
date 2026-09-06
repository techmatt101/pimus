import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import type net from 'node:net'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {AudioSystem} from '../../src/audio/system.mjs'

class FakeSocket extends EventEmitter {
    writes: Record<string, unknown>[] = []
    write(line: string): boolean {
        this.writes.push(JSON.parse(line) as Record<string, unknown>)
        return true
    }
    destroy(): void { this.emit('close') }
    state(value: Record<string, unknown>): void {
        this.emit('data', `${JSON.stringify({event: 'state', ...value})}\n`)
    }
}

test('USB controls, state and reconnect replay stay independent of manager state', async (t) => {
    const sockets = new Map<string, FakeSocket[]>()
    const audio = new AudioSystem({
        socketPath: 'manager', usbSocketPath: 'usb', reconnectMilliseconds: 1,
        connectSocket: (path) => {
            const socket = new FakeSocket()
            sockets.set(path, [...(sockets.get(path) ?? []), socket])
            return socket as unknown as net.Socket
        },
    })
    t.after(() => audio.close())
    audio.connect()
    const manager = sockets.get('manager')?.[0]
    const usb = sockets.get('usb')?.[0]
    assert.ok(manager && usb)
    manager.emit('connect')
    usb.emit('connect')
    manager.state({
        sources: {sendspin: {trim: 90}, aux: {trim: 80, enabled: false}},
        music_bus: {volume: 40}, voice_bus: {volume: 60},
    })
    assert.equal(audio.state.routesKnown, false)
    usb.state({sources: {usb: {trim: 25, enabled: true}}, usb_playback: true})
    assert.deepEqual(audio.state.sources, {
        sendspin: {trim: 90}, aux: {trim: 80, enabled: false}, usb: {trim: 25, enabled: true},
    })
    assert.equal(audio.state.routesKnown, true)
    assert.equal(audio.state.usbPlayback, true)
    audio.setSourceState('usb', 'off')
    audio.setSourceTrim('usb', 30)
    audio.setMusicVolume(50)
    assert.deepEqual(usb.writes.slice(1), [
        {command: 'set-source-state', name: 'usb', state: 'off'},
        {command: 'set-source-trim', name: 'usb', percent: 30},
    ])
    assert.deepEqual(manager.writes.slice(1), [{command: 'set-music-volume', percent: 50}])
    manager.state({sources: {sendspin: {trim: 90}, aux: {trim: 80, enabled: true}}, music_bus: {volume: 50}})
    assert.deepEqual(audio.state.sources, {
        sendspin: {trim: 90}, aux: {trim: 80, enabled: true}, usb: {trim: 30, enabled: false},
    })
    assert.equal(audio.state.usbPlayback, true)
    usb.destroy()
    assert.equal(audio.state.usbPlayback, false)
    // A room whose USB input service has gone is not a healthy room, and
    // nothing else would say so; the manager's own client is untouched, which
    // the cached state and its independent reconnect below prove.
    assert.equal(audio.connected, false)
    for (let attempt = 0; attempt < 30 && sockets.get('usb')?.length !== 2; attempt++) await delay(2)
    const replacement = sockets.get('usb')?.[1]
    assert.ok(replacement)
    replacement.emit('connect')
    assert.deepEqual(replacement.writes, [
        {command: 'set-source-state', name: 'usb', state: 'off'},
        {command: 'set-source-trim', name: 'usb', percent: 30},
    ])
    replacement.state({sources: {usb: {trim: 30, enabled: false}}, usb_playback: true})
    assert.equal(audio.state.musicVolume, 50)
    assert.equal(audio.state.usbPlayback, true)
    assert.equal(audio.connected, true)
    assert.equal(sockets.get('manager')?.length, 1)
})

test('a deployment without USB exposes only the manager routes', (t) => {
    const socket = new FakeSocket()
    const audio = new AudioSystem({socketPath: 'manager', connectSocket: () => socket as unknown as net.Socket})
    t.after(() => audio.close())
    audio.connect()
    socket.emit('connect')
    socket.state({sources: {sendspin: {trim: 100}}})
    // With no USB service configured there is none to be missing.
    assert.equal(audio.connected, true)
    assert.equal(audio.state.routesKnown, true)
    assert.deepEqual(audio.state.sources, {sendspin: {trim: 100}})
    assert.equal(audio.state.usbPlayback, false)
    audio.setSourceState('usb', 'on')
    assert.deepEqual(socket.writes, [{command: 'get-state'}])
})
