import WebSocket, {type RawData} from 'ws'

import {EntityStore} from './store.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../types.mjs'

interface HomeAssistantMessage {
    id?: number
    type?: string
    success?: boolean
    result?: unknown
    event?: {
        event_type?: string
        data?: Record<string, unknown> & { entity_id?: string; new_state?: HomeAssistantEntity | null }
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

export function websocketUrl(url: string): string {
    const base = url.replace(/\/+$/, '').replace(/\/api\/websocket$/, '')
    return `${base.replace(/^http/i, 'ws')}/api/websocket`
}

export class HomeAssistantClient implements HomeAssistantService {
    readonly url: string
    readonly #token: string
    readonly #store = new EntityStore()
    readonly #onStateChange: () => void
    readonly #reconnectMilliseconds: number
    readonly #WebSocketImpl: typeof WebSocket
    readonly #logger: Pick<Console, 'log' | 'error'>
    #socket: WebSocket | null = null
    #reconnectTimer: NodeJS.Timeout | null = null
    #authenticated = false
    // Kept across reconnects: the subscriptions belong to the socket, the
    // listeners do not.
    readonly #eventListeners = new Map<string, Set<(data: Record<string, unknown>) => void>>()
    // Home Assistant requires strictly increasing ids on an authenticated socket.
    #nextId = 1
    #statesRequestId = 0
    #statesQueued = false

    constructor({
                    url,
                    token,
                    onStateChange = () => {
                    },
                    reconnectMilliseconds = 5000,
                    WebSocketImpl = WebSocket,
                    logger = console,
                }: HomeAssistantClientOptions) {
        this.url = websocketUrl(url)
        this.#token = token
        this.#onStateChange = onStateChange
        this.#reconnectMilliseconds = reconnectMilliseconds
        this.#WebSocketImpl = WebSocketImpl
        this.#logger = logger
    }

    get connected(): boolean {
        return this.#authenticated
    }

    entity(entityId: string): HomeAssistantEntity | undefined {
        return this.#store.get(entityId)
    }

    watch(entityIds: readonly string[], listener: () => void): () => void {
        const unwatch = this.#store.watch(entityIds, listener)
        // A tile mounted after the snapshot arrived would otherwise draw unknown
        // state until its entity next changed — minutes for a temperature
        // sensor, never for a scene.
        if (entityIds.some((id) => !this.#store.get(id))) this.#queueStates()
        return unwatch
    }

    // Subscribed once per type and re-made after every reconnect; an event fired
    // while the socket is down is missed rather than arriving late.
    listen(eventType: string, listener: (data: Record<string, unknown>) => void): () => void {
        const listeners = this.#eventListeners.get(eventType)
        if (listeners) {
            listeners.add(listener)
        } else {
            this.#eventListeners.set(eventType, new Set([listener]))
            this.#subscribeEvent(eventType)
        }
        return () => {
            this.#eventListeners.get(eventType)?.delete(listener)
        }
    }

    call(domain: string, service: string, entityId: string, data?: Record<string, unknown>): void {
        this.#send({
            type: 'call_service',
            domain,
            service,
            target: {entity_id: entityId},
            ...(data ? {service_data: data} : {}),
        })
    }

    connect(): void {
        const socket = new this.#WebSocketImpl(this.url)
        this.#socket = socket
        socket.on('message', (raw: RawData) => this.receive(raw))
        socket.on('close', () => {
            if (this.#socket !== socket) return
            this.#socket = null
            this.#authenticated = false
            this.#store.clear()
            this.#onStateChange()
            this.scheduleReconnect()
        })
        // A refused connection arrives as an error then a close; the close
        // handler owns the retry, so this only stops 'error' from throwing.
        socket.on('error', () => {
        })
    }

    receive(raw: RawData): void {
        let message: HomeAssistantMessage
        try {
            message = JSON.parse(raw.toString()) as HomeAssistantMessage
        } catch (error) {
            this.#logger.error('invalid Home Assistant message', error)
            return
        }

        if (message.type === 'auth_required') {
            // The auth handshake is the one exchange that carries no id.
            this.#socket?.send(JSON.stringify({type: 'auth', access_token: this.#token}))
            return
        }
        if (message.type === 'auth_invalid') {
            this.#logger.error('Home Assistant rejected the access token; check home_assistant_token')
            return
        }
        if (message.type === 'auth_ok') {
            this.#authenticated = true
            this.#logger.log('connected to Home Assistant')
            this.#send({type: 'subscribe_events', event_type: 'state_changed'})
            for (const eventType of this.#eventListeners.keys()) this.#subscribeEvent(eventType)
            this.#requestStates()
            this.#onStateChange()
            return
        }

        if (message.type === 'result' && message.id === this.#statesRequestId) {
            if (Array.isArray(message.result)) this.#store.replace(message.result as HomeAssistantEntity[])
            this.#onStateChange()
            return
        }
        if (message.type === 'result' && message.success === false) {
            this.#logger.error('Home Assistant rejected a request', message.result)
            return
        }

        if (message.type === 'event') {
            const eventType = message.event?.event_type
            if (eventType === 'state_changed') {
                const updated = message.event?.data?.new_state
                // A removed entity reports a null new_state.
                if (!updated?.entity_id) return
                if (!this.#store.watched().has(updated.entity_id)) return
                this.#store.set(updated)
                this.#onStateChange()
                return
            }
            const listeners = eventType ? this.#eventListeners.get(eventType) : undefined
            if (!listeners) return
            // Copy first so a listener that unsubscribes mid-notification is safe.
            for (const listener of [...listeners]) listener(message.event?.data ?? {})
        }
    }

    scheduleReconnect(): void {
        if (this.#reconnectTimer) return
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null
            this.connect()
        }, this.#reconnectMilliseconds)
    }

    #send(payload: Record<string, unknown>): number {
        const socket = this.#socket
        if (!this.#authenticated || socket?.readyState !== this.#WebSocketImpl.OPEN) return 0
        const id = this.#nextId
        this.#nextId += 1
        socket.send(JSON.stringify({id, ...payload}))
        return id
    }

    #subscribeEvent(eventType: string): void {
        this.#send({type: 'subscribe_events', event_type: eventType})
    }

    #requestStates(): void {
        this.#statesQueued = false
        const id = this.#send({type: 'get_states'})
        if (id) this.#statesRequestId = id
    }

    // Coalesces the snapshot requests a page change produces: mounting six
    // tiles that each watch an unknown entity should ask Home Assistant once.
    #queueStates(): void {
        if (this.#statesQueued || !this.#authenticated) return
        this.#statesQueued = true
        setTimeout(() => this.#requestStates(), 0).unref()
    }
}

export function createOfflineHomeAssistant(
    logger: Pick<Console, 'log'> = console,
): HomeAssistantService {
    return {
        connected: false,
        entity: () => undefined,
        call: (domain, service, entityId) => {
            logger.log(`no Home Assistant configured; dropped ${domain}.${service} on ${entityId}`)
        },
        watch: () => () => {
        },
        listen: () => () => {
        },
    }
}
