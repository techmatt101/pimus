import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'

import {HomeAssistantClient} from '../../src/home-assistant/client.mjs'
import type WebSocket from 'ws'

class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1
    static readonly instances: FakeWebSocket[] = []
    readonly sent: Record<string, unknown>[] = []
    readyState = FakeWebSocket.OPEN

    constructor(readonly uri: string) {
        super()
        FakeWebSocket.instances.push(this)
    }

    send(value: string): void {
        this.sent.push(JSON.parse(value) as Record<string, unknown>)
    }

    deliver(message: Record<string, unknown>): void {
        this.emit('message', Buffer.from(JSON.stringify(message)))
    }

    lastOf(type: string): Record<string, unknown> | undefined {
        return [...this.sent].reverse().find((message) => message.type === type)
    }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

test('the deck subscribes to the entities it watches and follows their diffs', async () => {
    const client = new HomeAssistantClient({
        url: 'http://homeassistant.local:8123',
        token: 'token',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        logger: {
            log: () => {
            }, error: () => {
            }
        },
    })
    client.connect()
    const socket = FakeWebSocket.instances[0]
    assert.ok(socket)

    // Tiles mount before the socket authenticates, so the first subscription
    // carries whatever the deck settled on.
    client.watch(['light.desk'], () => {
    })
    socket.deliver({type: 'auth_required'})
    socket.deliver({type: 'auth_ok'})

    const subscribe = socket.lastOf('subscribe_entities')
    assert.deepEqual(subscribe?.entity_ids, ['light.desk'])
    const subscriptionId = subscribe?.id

    socket.deliver({
        id: subscriptionId,
        type: 'event',
        event: {a: {'light.desk': {s: 'on', a: {friendly_name: 'Desk', brightness: 120}}}},
    })
    assert.equal(client.entity('light.desk')?.state, 'on')
    assert.equal(client.entity('light.desk')?.attributes.brightness, 120)

    // A diff carries only what moved: `+` overwrites, `-` names what went away.
    socket.deliver({
        id: subscriptionId,
        type: 'event',
        event: {c: {'light.desk': {'+': {s: 'off'}, '-': {a: ['brightness']}}}},
    })
    assert.equal(client.entity('light.desk')?.state, 'off')
    assert.equal(client.entity('light.desk')?.attributes.brightness, undefined)
    assert.equal(client.entity('light.desk')?.attributes.friendly_name, 'Desk')

    // An attribute-only change keeps the state it did not mention.
    socket.deliver({
        id: subscriptionId,
        type: 'event',
        event: {c: {'light.desk': {'+': {a: {brightness: 4}}}}},
    })
    assert.equal(client.entity('light.desk')?.state, 'off')
    assert.equal(client.entity('light.desk')?.attributes.brightness, 4)

    // A page change replaces the subscription once, with the set it settled on.
    const unwatch = client.watch(['sensor.office'], () => {
    })
    client.watch(['scene.evening'], () => {
    })
    unwatch()
    await settle()
    assert.deepEqual(socket.lastOf('unsubscribe_events')?.subscription, subscriptionId)
    assert.deepEqual(socket.lastOf('subscribe_entities')?.entity_ids, ['light.desk', 'scene.evening'])

    // The replacement's first block is authoritative: an entity the old
    // subscription cached but the new one does not carry is gone.
    const replacement = socket.lastOf('subscribe_entities')?.id
    socket.deliver({
        id: replacement,
        type: 'event',
        event: {a: {'scene.evening': {s: 'unknown', a: {}}}},
    })
    assert.equal(client.entity('light.desk'), undefined)
    assert.equal(client.entity('scene.evening')?.state, 'unknown')

    socket.deliver({id: replacement, type: 'event', event: {r: ['scene.evening']}})
    assert.equal(client.entity('scene.evening'), undefined)
})

test('an intent is posted for the device behind the entity, looked up once', async () => {
    const posted: {url: string; body: unknown}[] = []
    const client = new HomeAssistantClient({
        url: 'http://homeassistant.local:8123/',
        token: 'token',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        fetchImpl: async (url, init) => {
            posted.push({url: String(url), body: JSON.parse(String(init?.body))})
            return new Response('{}', {status: 200})
        },
        logger: {
            log: () => {
            }, error: () => {
            }
        },
    })
    client.connect()
    const socket = FakeWebSocket.instances.at(-1)
    assert.ok(socket)
    socket.deliver({type: 'auth_ok'})

    client.intent('HassStartTimer', {minutes: 5}, 'assist_satellite.office_amp')
    const lookup = socket.lastOf('config/entity_registry/get')
    assert.equal(lookup?.entity_id, 'assist_satellite.office_amp')
    socket.deliver({id: lookup?.id, type: 'result', success: true, result: {device_id: 'dev-1'}})
    await settle()

    assert.equal(posted[0]?.url, 'http://homeassistant.local:8123/api/intent/handle')
    assert.deepEqual(posted[0]?.body, {
        name: 'HassStartTimer',
        data: {minutes: 5},
        device_id: 'dev-1',
    })

    // The registry answer is kept, so pressing the key again is one request.
    client.intent('HassCancelTimer', {}, 'assist_satellite.office_amp')
    await settle()
    assert.equal(socket.sent.filter((message) => message.type === 'config/entity_registry/get').length, 1)
    assert.deepEqual(posted[1]?.body, {
        name: 'HassCancelTimer',
        data: {},
        device_id: 'dev-1',
    })
})
