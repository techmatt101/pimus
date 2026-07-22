// The remote-tile server, exercised over real loopback sockets: a WebSocket
// server is plain code with no hardware behind it, so these tests connect an
// actual `ws` client to an ephemeral port rather than faking the transport.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createCanvas } from '@napi-rs/canvas'
import WebSocket from 'ws'

import { RemoteTileServer } from '../../src/remote/server.mjs'
import { eventually } from '../support/fixtures.mjs'

const TOKEN = 'shared-secret'

/** A solid 120x120 PNG, as a client would send one. */
function pngBase64(color: string): string {
  const canvas = createCanvas(120, 120)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 120, 120)
  return canvas.toBuffer('image/png').toString('base64')
}

interface TestContext {
  after(fn: () => void): void
}

/** A server on an ephemeral loopback port, stopped when the test ends. */
async function startServer(context: TestContext) {
  const notifications: Array<Record<string, unknown>> = []
  const counters = { changes: 0 }
  const server = new RemoteTileServer({
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    onChange: () => { counters.changes += 1 },
    postNotification: (data) => notifications.push(data),
    logger: { log: () => {} },
  })
  server.start()
  context.after(() => server.stop())
  await eventually(() => server.port !== 0)
  return { server, counters, notifications }
}

/** A connected client that records everything the server sends it. */
class TestClient {
  readonly received: Array<Record<string, unknown>> = []
  closedWith: number | null = null
  constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => this.received.push(JSON.parse(String(raw)) as Record<string, unknown>))
    socket.on('close', (code) => { this.closedWith = code })
    socket.on('error', () => {})
  }
  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message))
  }
  close(): void {
    this.socket.close()
  }
}

async function connect(context: TestContext, port: number): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  const client = new TestClient(socket)
  context.after(() => socket.terminate())
  await new Promise((resolve, reject) => {
    socket.on('open', resolve)
    socket.on('error', reject)
  })
  return client
}

/** Connect and complete the hello handshake, as every real client must. */
async function connectAndHello(context: TestContext, port: number): Promise<TestClient> {
  const client = await connect(context, port)
  client.send({ type: 'hello', token: TOKEN })
  await eventually(() => client.received.some((message) => message.type === 'welcome'))
  return client
}

test('a connection is closed unless its first message is a hello with the token', async (context) => {
  const { server } = await startServer(context)

  const wrongToken = await connect(context, server.port)
  wrongToken.send({ type: 'hello', token: 'guess' })
  await eventually(() => wrongToken.closedWith !== null)
  assert.equal(wrongToken.closedWith, 4003)

  // A tile pushed before the handshake is refused the same way, so nothing is
  // ever accepted from a connection that has not authenticated.
  const noHello = await connect(context, server.port)
  noHello.send({ type: 'tile', slot: 0, label: 'SNEAK' })
  await eventually(() => noHello.closedWith !== null)
  assert.equal(noHello.closedWith, 4003)
  assert.equal(server.tile(0), undefined)
})

test('a pushed face reaches its slot with the image decoded', async (context) => {
  const { server, counters } = await startServer(context)
  const client = await connectAndHello(context, server.port)

  client.send({ type: 'tile', slot: 2, label: 'SLACK', color: '#4a154b', image: pngBase64('#ff0000') })
  await eventually(() => server.tile(2) !== undefined)

  const face = server.tile(2)
  assert.equal(face?.label, 'SLACK')
  assert.equal(face?.color, '#4a154b')
  assert.equal(face?.image?.width, 120)
  assert.ok(counters.changes >= 1, 'the deck was told to repaint')
})

test('a face with no colour or label still shows something deliberate', async (context) => {
  const { server } = await startServer(context)
  const client = await connectAndHello(context, server.port)

  client.send({ type: 'tile', slot: 0 })
  await eventually(() => server.tile(0) !== undefined)
  const face = server.tile(0)
  assert.equal(face?.label, '')
  assert.match(face?.color ?? '', /^#[0-9a-f]{6}$/i)
})

test('pressing a slot reports back to the client that owns it', async (context) => {
  const { server } = await startServer(context)
  const client = await connectAndHello(context, server.port)

  client.send({ type: 'tile', slot: 1, label: 'PING' })
  await eventually(() => server.tile(1) !== undefined)

  server.press(1)
  await eventually(() => client.received.some((message) => message.type === 'press'))
  assert.deepEqual(
    client.received.find((message) => message.type === 'press'),
    { type: 'press', slot: 1 },
  )
  // A press on an empty slot has no owner to reach and must simply do nothing.
  server.press(0)
})

test('clear empties a slot, and disconnecting takes every owned face with it', async (context) => {
  const { server } = await startServer(context)
  const client = await connectAndHello(context, server.port)

  client.send({ type: 'tile', slot: 0, label: 'A' })
  client.send({ type: 'tile', slot: 5, label: 'B' })
  await eventually(() => server.tile(0) !== undefined && server.tile(5) !== undefined)

  client.send({ type: 'clear', slot: 0 })
  await eventually(() => server.tile(0) === undefined)
  assert.ok(server.tile(5), 'the other slot is untouched')

  client.close()
  await eventually(() => server.tile(5) === undefined)
})

test('a notify message joins the strip queue unaltered', async (context) => {
  const { server, notifications } = await startServer(context)
  const client = await connectAndHello(context, server.port)

  client.send({ type: 'notify', title: 'SLACK', message: 'DM FROM SAM', color: '#4a154b', seconds: 5 })
  await eventually(() => notifications.length === 1)
  assert.equal(notifications[0]?.message, 'DM FROM SAM')
})

test('a bad message is answered with an error and changes nothing', async (context) => {
  const { server } = await startServer(context)
  const client = await connectAndHello(context, server.port)

  client.send({ type: 'tile', slot: 9, label: 'OFF THE GRID' })
  client.send({ type: 'tile', slot: 3, image: 'not a png' })
  client.send({ type: 'juggle' })
  await eventually(() => client.received.filter((message) => message.type === 'error').length === 3)

  assert.equal(server.tile(9), undefined)
  assert.equal(server.tile(3), undefined)
  assert.equal(client.closedWith, null, 'a mistake does not cost the connection')
})
