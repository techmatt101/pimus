// The remote-tile socket: a WebSocket server another computer on the LAN
// connects to, pushing key faces onto the deck's REMOTE page and receiving
// presses back. This is how a machine that is not the Pi — a Mac watching
// Slack, say — gets a live key on the deck without owning any hardware; the
// controller stays the single owner of the Stream Deck and this server is just
// another feed into it, the way Home Assistant is.
//
// It is also the controller's one inbound listener, which the rest of the
// design deliberately avoids, so it is off unless both `remote.enabled` and a
// shared token are configured, and every connection must present that token
// before anything else is read from it.
//
// The protocol is a handful of JSON messages:
//
//   client -> {"type": "hello", "token": "..."}          must come first
//   client -> {"type": "tile", "slot": 0, "label": "SLACK",
//              "color": "#4a154b", "image": "<base64 PNG>"}
//   client -> {"type": "clear", "slot": 0}
//   client -> {"type": "notify", "title": "SLACK", "message": "...",
//              "color": "#4a154b", "seconds": 8}         a strip banner
//   server -> {"type": "welcome", "slots": 6}
//   server -> {"type": "press", "slot": 0}
//   server -> {"type": "error", "message": "..."}        the message was ignored
//
// A slot's face lives exactly as long as its connection: a client that dies
// takes its keys with it, so a crashed app can never leave stale tiles on the
// deck. See apps/remote-demo for a runnable client.

import { loadImage } from '@napi-rs/canvas'
import { createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'

import type { RemoteTileFeed, RemoteTileFace } from '../types.mjs'

/** The REMOTE page's capacity: the six named slots of a PageGrid. */
export const REMOTE_SLOT_COUNT = 6

/** A frame ceiling generous enough for a 120x120 PNG, far under a real photo. */
const MAX_PAYLOAD = 512 * 1024
/** A connection that has not said hello by then is not a client. */
const HELLO_TIMEOUT_MS = 5000
const MAX_LABEL = 16
const DEFAULT_COLOR = '#263238'

export interface RemoteTileServerOptions {
  port: number
  token: string
  /** Bind address; the default reaches the LAN, tests bind the loopback. */
  host?: string
  /** Called whenever a face changes, so the deck repaints without waiting. */
  onChange?: () => void
  /** Forwards a `notify` message to the strip's notification queue. */
  postNotification?: (data: Record<string, unknown>) => void
  logger?: Pick<Console, 'log'>
}

export class RemoteTileServer implements RemoteTileFeed {
  private readonly options: RemoteTileServerOptions
  private readonly onChange: () => void
  private readonly logger: Pick<Console, 'log'>
  private readonly tiles = new Map<number, { face: RemoteTileFace; owner: WebSocket }>()
  private server: WebSocketServer | null = null

  constructor(options: RemoteTileServerOptions) {
    this.options = options
    this.onChange = options.onChange ?? (() => {})
    this.logger = options.logger ?? console
  }

  /** Begin listening. Safe to call once; index.mts does it at startup. */
  start(): void {
    if (this.server) return
    this.server = new WebSocketServer({
      port: this.options.port,
      host: this.options.host ?? '0.0.0.0',
      maxPayload: MAX_PAYLOAD,
    })
    this.server.on('connection', (socket) => this.accept(socket))
    // A port collision or bind failure must not take the daemon down with it;
    // the deck simply runs without remote tiles until a restart.
    this.server.on('error', (error) => this.logger.log(`remote-tile server error: ${String(error)}`))
  }

  /** The bound port, for a test listening on an ephemeral one. */
  get port(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address ? address.port : this.options.port
  }

  stop(): void {
    for (const client of this.server?.clients ?? []) client.terminate()
    this.server?.close()
    this.server = null
    this.tiles.clear()
  }

  tile(slot: number): RemoteTileFace | undefined {
    return this.tiles.get(slot)?.face
  }

  press(slot: number): void {
    const owner = this.tiles.get(slot)?.owner
    if (owner && owner.readyState === owner.OPEN) owner.send(JSON.stringify({ type: 'press', slot }))
  }

  /** Gate a new connection behind the hello handshake before reading anything else. */
  private accept(socket: WebSocket): void {
    let welcomed = false
    const deadline = setTimeout(() => {
      if (!welcomed) socket.close(4001, 'hello timeout')
    }, HELLO_TIMEOUT_MS)
    deadline.unref()

    socket.on('message', (raw) => {
      const message = parse(raw)
      if (!message) {
        socket.close(4002, 'not JSON')
        return
      }
      if (!welcomed) {
        if (message.type !== 'hello' || !tokenMatches(message.token, this.options.token)) {
          socket.close(4003, 'bad hello')
          return
        }
        welcomed = true
        clearTimeout(deadline)
        this.logger.log('remote-tile client connected')
        socket.send(JSON.stringify({ type: 'welcome', slots: REMOTE_SLOT_COUNT }))
        return
      }
      void this.handle(socket, message)
    })

    socket.on('close', () => {
      clearTimeout(deadline)
      if (!welcomed) return
      this.logger.log('remote-tile client disconnected')
      this.dropOwnedBy(socket)
    })
    // Treat a broken client as a disconnect, never as a reason to crash.
    socket.on('error', () => {})
  }

  private async handle(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
    const complain = (text: string): void => {
      socket.send(JSON.stringify({ type: 'error', message: text }))
    }

    if (message.type === 'tile') {
      const slot = slotOf(message)
      if (slot === undefined) return complain(`tile needs a slot from 0 to ${REMOTE_SLOT_COUNT - 1}`)
      const face: RemoteTileFace = {
        label: typeof message.label === 'string' ? message.label.slice(0, MAX_LABEL) : '',
        color: typeof message.color === 'string' && /^#[0-9a-f]{6}$/i.test(message.color)
          ? message.color
          : DEFAULT_COLOR,
      }
      if (typeof message.image === 'string' && message.image.length > 0) {
        // Decoded here, once, so a repaint only ever draws a ready image.
        try {
          face.image = await loadImage(Buffer.from(message.image, 'base64'))
        } catch {
          return complain(`tile ${slot} image is not a decodable PNG`)
        }
      }
      // The decode yielded, and a face may not outlive its connection: a client
      // that disconnected while its PNG was decoding gets nothing on the deck.
      if (socket.readyState !== socket.OPEN) return
      // Last write wins, including across clients; the face's lifetime follows
      // whichever connection wrote it.
      this.tiles.set(slot, { face, owner: socket })
      this.onChange()
      return
    }

    if (message.type === 'clear') {
      const slot = slotOf(message)
      if (slot === undefined) return complain(`clear needs a slot from 0 to ${REMOTE_SLOT_COUNT - 1}`)
      if (this.tiles.delete(slot)) this.onChange()
      return
    }

    if (message.type === 'notify') {
      // The queue applies its own limits and defaults; this only forwards.
      this.options.postNotification?.(message)
      return
    }

    complain(`unknown message type ${JSON.stringify(message.type ?? null)}`)
  }

  private dropOwnedBy(socket: WebSocket): void {
    let dropped = false
    for (const [slot, entry] of this.tiles) {
      if (entry.owner === socket) {
        this.tiles.delete(slot)
        dropped = true
      }
    }
    if (dropped) this.onChange()
  }
}

function parse(raw: RawData): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(String(raw))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function slotOf(message: Record<string, unknown>): number | undefined {
  const slot = message.slot
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < REMOTE_SLOT_COUNT
    ? slot
    : undefined
}

/** Compare in constant time, so the token cannot be guessed letter by letter. */
function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(presented), digest(expected))
}
