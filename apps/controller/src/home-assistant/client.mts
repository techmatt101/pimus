// The Home Assistant WebSocket API client. It authenticates with a long-lived
// access token, keeps the entities the control surface watches in an
// EntityStore, and calls services on the same socket.
//
// Unlike the write-only `webhook` action, tiles need to *read* state — a fan
// key that cannot show whether the fan is on is a light switch with no
// indicator — so this connection is what makes the Home Assistant tiles in
// streamdeck/tiles/ possible. A deployment with no Home Assistant configured
// injects `createOfflineHomeAssistant()` instead, and those tiles draw unknown
// state without any special-casing.
//
// Disconnects are normal: the socket reconnects on the same schedule as the LVA
// client, and the cache is cleared on the way down so nothing stale looks live.

import WebSocket, { type RawData } from 'ws'

import { EntityStore } from './store.mjs'
import type { HomeAssistantEntity, HomeAssistantService } from '../types.mjs'

/** Messages the client understands; anything else is ignored. */
interface HomeAssistantMessage {
  id?: number
  type?: string
  success?: boolean
  result?: unknown
  event?: {
    event_type?: string
    data?: { entity_id?: string; new_state?: HomeAssistantEntity | null }
  }
}

export interface HomeAssistantClientOptions {
  /** Base URL of the instance, e.g. `http://homeassistant.local:8123`. */
  url: string
  token: string
  onStateChange?: () => void
  reconnectMilliseconds?: number
  WebSocketImpl?: typeof WebSocket
  logger?: Pick<Console, 'log' | 'error'>
}

/**
 * Turns the configured base URL into the WebSocket API endpoint. Accepting the
 * plain `http://host:8123` an operator already knows keeps the inventory
 * setting the same one they paste into a browser.
 */
export function websocketUrl(url: string): string {
  const base = url.replace(/\/+$/, '').replace(/\/api\/websocket$/, '')
  return `${base.replace(/^http/i, 'ws')}/api/websocket`
}

export class HomeAssistantClient implements HomeAssistantService {
  readonly url: string
  private readonly token: string
  private readonly store = new EntityStore()
  private readonly onStateChange: () => void
  private readonly reconnectMilliseconds: number
  private readonly WebSocketImpl: typeof WebSocket
  private readonly logger: Pick<Console, 'log' | 'error'>
  private socket: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private authenticated = false
  // Home Assistant requires strictly increasing ids on an authenticated socket.
  private nextId = 1
  // Which reply carries the entity snapshot; other results are acknowledgements.
  private statesRequestId = 0
  private statesQueued = false

  constructor({
    url,
    token,
    onStateChange = () => {},
    reconnectMilliseconds = 5000,
    WebSocketImpl = WebSocket,
    logger = console,
  }: HomeAssistantClientOptions) {
    this.url = websocketUrl(url)
    this.token = token
    this.onStateChange = onStateChange
    this.reconnectMilliseconds = reconnectMilliseconds
    this.WebSocketImpl = WebSocketImpl
    this.logger = logger
  }

  get connected(): boolean {
    return this.authenticated
  }

  entity(entityId: string): HomeAssistantEntity | undefined {
    return this.store.get(entityId)
  }

  watch(entityIds: readonly string[], listener: () => void): () => void {
    const unwatch = this.store.watch(entityIds, listener)
    // A tile mounted after the snapshot arrived would otherwise draw unknown
    // state until its entity next changed, which for a temperature sensor can
    // be minutes and for a scene is never.
    if (entityIds.some((id) => !this.store.get(id))) this.queueStates()
    return unwatch
  }

  call(domain: string, service: string, entityId: string, data?: Record<string, unknown>): void {
    this.send({
      type: 'call_service',
      domain,
      service,
      target: { entity_id: entityId },
      ...(data ? { service_data: data } : {}),
    })
  }

  connect(): void {
    const socket = new this.WebSocketImpl(this.url)
    this.socket = socket
    socket.on('message', (raw: RawData) => this.receive(raw))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.authenticated = false
      // Drop the cache so a fan key stops claiming to know the fan is on.
      this.store.clear()
      this.onStateChange()
      this.scheduleReconnect()
    })
    // A refused connection arrives as an error then a close; the close handler
    // owns the retry, so this only stops an unhandled 'error' from throwing.
    socket.on('error', () => {})
  }

  receive(raw: RawData): void {
    let message: HomeAssistantMessage
    try {
      message = JSON.parse(raw.toString()) as HomeAssistantMessage
    } catch (error) {
      this.logger.error('invalid Home Assistant message', error)
      return
    }

    if (message.type === 'auth_required') {
      // The auth handshake is the one exchange that carries no id.
      this.socket?.send(JSON.stringify({ type: 'auth', access_token: this.token }))
      return
    }
    if (message.type === 'auth_invalid') {
      this.logger.error('Home Assistant rejected the access token; check home_assistant_token')
      return
    }
    if (message.type === 'auth_ok') {
      this.authenticated = true
      this.logger.log('connected to Home Assistant')
      this.send({ type: 'subscribe_events', event_type: 'state_changed' })
      this.requestStates()
      this.onStateChange()
      return
    }

    if (message.type === 'result' && message.id === this.statesRequestId) {
      if (Array.isArray(message.result)) this.store.replace(message.result as HomeAssistantEntity[])
      this.onStateChange()
      return
    }
    if (message.type === 'result' && message.success === false) {
      this.logger.error('Home Assistant rejected a request', message.result)
      return
    }

    if (message.type === 'event' && message.event?.event_type === 'state_changed') {
      const updated = message.event.data?.new_state
      // A removed entity reports a null new_state; nothing to cache for it.
      if (!updated?.entity_id) return
      if (!this.store.watched().has(updated.entity_id)) return
      this.store.set(updated)
      this.onStateChange()
    }
  }

  scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectMilliseconds)
  }

  /** Send a command on the authenticated socket, dropping it if there is none. */
  private send(payload: Record<string, unknown>): number {
    const socket = this.socket
    if (!this.authenticated || socket?.readyState !== this.WebSocketImpl.OPEN) return 0
    const id = this.nextId
    this.nextId += 1
    socket.send(JSON.stringify({ id, ...payload }))
    return id
  }

  private requestStates(): void {
    this.statesQueued = false
    const id = this.send({ type: 'get_states' })
    if (id) this.statesRequestId = id
  }

  /**
   * Coalesce the snapshot requests a page change produces: mounting six tiles
   * that each watch an unknown entity should ask Home Assistant once.
   */
  private queueStates(): void {
    if (this.statesQueued || !this.authenticated) return
    this.statesQueued = true
    setTimeout(() => this.requestStates(), 0).unref()
  }
}

/**
 * The stand-in used when no Home Assistant is configured. Every entity reads as
 * unknown and every service call is logged and dropped, so Home Assistant tiles
 * stay on the deck and simply draw an unknown state instead of the layout
 * needing to know whether the integration is enabled.
 */
export function createOfflineHomeAssistant(
  logger: Pick<Console, 'log'> = console,
): HomeAssistantService {
  return {
    connected: false,
    entity: () => undefined,
    call: (domain, service, entityId) => {
      logger.log(`no Home Assistant configured; dropped ${domain}.${service} on ${entityId}`)
    },
    watch: () => () => {},
  }
}
