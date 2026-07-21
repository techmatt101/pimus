import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createOfflineHomeAssistant, HomeAssistantClient, websocketUrl } from '../../src/home-assistant/client.mjs'
import type WebSocket from 'ws'

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1
  static readonly instances: FakeWebSocket[] = []
  readonly sent: Array<Record<string, unknown>> = []
  readyState = FakeWebSocket.OPEN

  constructor(readonly uri: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value) as Record<string, unknown>)
  }

  /** Deliver a message from Home Assistant to the client. */
  deliver(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)))
  }
}

const quiet = { log: () => {}, error: () => {} }

/** A connected, authenticated client plus the socket it is talking over. */
const connected = (): { client: HomeAssistantClient; socket: FakeWebSocket } => {
  FakeWebSocket.instances.length = 0
  const client = new HomeAssistantClient({
    url: 'http://homeassistant.local:8123',
    token: 'secret-token',
    reconnectMilliseconds: 0,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    logger: quiet,
  })
  client.connect()
  const socket = FakeWebSocket.instances[0]
  assert.ok(socket)
  socket.deliver({ type: 'auth_required', ha_version: '2026.7' })
  socket.deliver({ type: 'auth_ok' })
  return { client, socket }
}

test('the configured base URL becomes the WebSocket API endpoint', () => {
  assert.equal(websocketUrl('http://homeassistant.local:8123'), 'ws://homeassistant.local:8123/api/websocket')
  assert.equal(websocketUrl('https://ha.example.com/'), 'wss://ha.example.com/api/websocket')
  // Pasting the endpoint itself, rather than the base URL, still works.
  assert.equal(websocketUrl('http://10.0.0.2:8123/api/websocket'), 'ws://10.0.0.2:8123/api/websocket')
})

test('the client authenticates, then subscribes and asks for the current states', () => {
  const { client, socket } = connected()

  assert.deepEqual(socket.sent[0], { type: 'auth', access_token: 'secret-token' })
  assert.equal(socket.sent[1]?.type, 'subscribe_events')
  assert.equal(socket.sent[1]?.event_type, 'state_changed')
  assert.equal(socket.sent[2]?.type, 'get_states')
  assert.equal(client.connected, true)
})

test('watched entities are cached and delivered; unwatched traffic is dropped', () => {
  const { client, socket } = connected()
  let changes = 0
  client.watch(['fan.office'], () => { changes += 1 })

  const statesId = socket.sent[2]?.id
  socket.deliver({
    id: statesId,
    type: 'result',
    success: true,
    result: [
      { entity_id: 'fan.office', state: 'off', attributes: {} },
      { entity_id: 'light.hall', state: 'on', attributes: {} },
    ],
  })
  assert.equal(client.entity('fan.office')?.state, 'off')
  assert.equal(client.entity('light.hall'), undefined, 'the cache holds only what is watched')

  socket.deliver({
    type: 'event',
    event: {
      event_type: 'state_changed',
      data: { entity_id: 'fan.office', new_state: { entity_id: 'fan.office', state: 'on', attributes: {} } },
    },
  })
  assert.equal(client.entity('fan.office')?.state, 'on')

  // A busy house sends constant state_changed traffic for entities no key draws.
  const before = changes
  socket.deliver({
    type: 'event',
    event: {
      event_type: 'state_changed',
      data: { entity_id: 'light.hall', new_state: { entity_id: 'light.hall', state: 'off', attributes: {} } },
    },
  })
  assert.equal(changes, before, 'unwatched entities cause no repaint')
})

test('calling a service targets the entity on the authenticated socket', () => {
  const { client, socket } = connected()
  client.call('fan', 'toggle', 'fan.office')
  client.call('light', 'turn_on', 'light.office', { brightness_step_pct: 10 })

  const calls = socket.sent.filter((message) => message.type === 'call_service')
  assert.deepEqual(calls[0], {
    id: calls[0]?.id,
    type: 'call_service',
    domain: 'fan',
    service: 'toggle',
    target: { entity_id: 'fan.office' },
  })
  assert.deepEqual(calls[1]?.service_data, { brightness_step_pct: 10 })
  // Home Assistant rejects a socket that reuses or lowers a message id.
  assert.ok(Number(calls[1]?.id) > Number(calls[0]?.id), 'message ids increase')
})

test('a disconnect clears the cache, reports it, and reconnects', async () => {
  const { client, socket } = connected()
  let changes = 0
  client.watch(['fan.office'], () => { changes += 1 })
  socket.deliver({
    id: socket.sent[2]?.id,
    type: 'result',
    success: true,
    result: [{ entity_id: 'fan.office', state: 'on', attributes: {} }],
  })
  assert.equal(client.entity('fan.office')?.state, 'on')

  socket.emit('close')
  assert.equal(client.connected, false)
  // Stale state must not keep reading as live; the key goes to unknown.
  assert.equal(client.entity('fan.office'), undefined)
  assert.ok(changes >= 1)

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(FakeWebSocket.instances.length, 2, 'a dropped connection is retried')
})

test('a service call before authentication is dropped rather than queued', () => {
  FakeWebSocket.instances.length = 0
  const client = new HomeAssistantClient({
    url: 'http://homeassistant.local:8123',
    token: 'secret-token',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    logger: quiet,
  })
  client.connect()
  const socket = FakeWebSocket.instances[0]
  assert.ok(socket)

  client.call('fan', 'toggle', 'fan.office')
  assert.deepEqual(socket.sent, [], 'nothing is sent on an unauthenticated socket')
})

test('with no Home Assistant configured every entity is unknown and calls are dropped', () => {
  const logged: string[] = []
  const offline = createOfflineHomeAssistant({ log: (message: string) => logged.push(message) })

  assert.equal(offline.connected, false)
  assert.equal(offline.entity('fan.office'), undefined)
  // The watch is still a real subscription contract, so a tile's unmount path
  // is identical whether or not Home Assistant is configured.
  assert.equal(typeof offline.watch(['fan.office'], () => {}), 'function')

  offline.call('fan', 'toggle', 'fan.office')
  assert.deepEqual(logged, ['no Home Assistant configured; dropped fan.toggle on fan.office'])
})
