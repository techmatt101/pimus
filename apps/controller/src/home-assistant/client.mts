import WebSocket, {type RawData} from 'ws'

import {decodeAdded, decodeChanged, decodeRemoved} from './compressed.mjs'
import {EntityStore} from './store.mjs'
import {logger} from '../log.mjs'
import type {HomeAssistantEntity, HomeAssistantService} from '../types.mjs'

const log = logger('ha')

interface EntityFeed {
    a?: unknown
    c?: unknown
    r?: unknown
}

interface HomeAssistantMessage {
    id?: number
    type?: string
    success?: boolean
    result?: unknown
    event?: EntityFeed & {
        event_type?: string
        data?: Record<string, unknown> & { entity_id?: string; new_state?: HomeAssistantEntity | null }
    }
}

function sameIds(wanted: readonly string[], subscribed: ReadonlySet<string>): boolean {
    return wanted.length === subscribed.size && wanted.every((id) => subscribed.has(id))
}

export interface HomeAssistantClientOptions {
    /** Base URL of the instance, e.g. `http://homeassistant.local:8123`. */
    url: string
    token: string
    onStateChange?: () => void
    reconnectMilliseconds?: number
    WebSocketImpl?: typeof WebSocket
    fetchImpl?: typeof fetch
    logger?: Pick<Console, 'log' | 'error'>
}

function baseUrl(url: string): string {
    return url.replace(/\/+$/, '').replace(/\/api\/websocket$/, '')
}

export function websocketUrl(url: string): string {
    return `${baseUrl(url).replace(/^http/i, 'ws')}/api/websocket`
}

interface EntityRegistryEntry {
    device_id?: string | null
}

export class HomeAssistantClient implements HomeAssistantService {
    readonly url: string
    readonly #restUrl: string
    readonly #token: string
    readonly #fetch: typeof fetch
    readonly #pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
    readonly #devices = new Map<string, Promise<string | undefined>>()
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
    // The deck watches a handful of entities out of a whole house, so the socket
    // carries those and nothing else. The subscription's id list is fixed, so a
    // page that mounts different tiles replaces it rather than amending it.
    #entitiesSubscriptionId = 0
    #subscribedIds: ReadonlySet<string> = new Set()
    #entitiesQueued = false
    #primed = false

    constructor({
                    url,
                    token,
                    onStateChange = () => {
                    },
                    reconnectMilliseconds = 5000,
                    WebSocketImpl = WebSocket,
                    fetchImpl = fetch,
                    logger = console,
                }: HomeAssistantClientOptions) {
        this.url = websocketUrl(url)
        this.#restUrl = baseUrl(url)
        this.#token = token
        this.#fetch = fetchImpl
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
        // Re-subscribing hands back the full state of the new set, so a tile
        // mounted long after the last one still draws immediately rather than
        // waiting for its entity to change — minutes for a temperature sensor,
        // never for a scene.
        this.#queueEntities()
        return () => {
            unwatch()
            this.#queueEntities()
        }
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
        log.debug('call', `${domain}.${service}`, entityId, data ? JSON.stringify(data) : '')
        this.#send({
            type: 'call_service',
            domain,
            service,
            target: {entity_id: entityId},
            ...(data ? {service_data: data} : {}),
        })
    }

    // Intents are the one part of Home Assistant with no WebSocket command:
    // they are posted to the REST API the same token authenticates.
    intent(name: string, data: Record<string, unknown>, deviceEntity: string): void {
        log.debug('intent', name, JSON.stringify(data), deviceEntity)
        void this.#postIntent(name, data, deviceEntity).catch((error: unknown) => {
            this.#logger.error(`Home Assistant rejected the ${name} intent`, error)
        })
    }

    async #postIntent(name: string, data: Record<string, unknown>, deviceEntity: string): Promise<void> {
        const deviceId = await this.#deviceIdFor(deviceEntity)
        if (deviceId === undefined) throw new Error(`no device behind ${deviceEntity}`)
        const response = await this.#fetch(`${this.#restUrl}/api/intent/handle`, {
            method: 'POST',
            headers: {authorization: `Bearer ${this.#token}`, 'content-type': 'application/json'},
            body: JSON.stringify({name, data, device_id: deviceId}),
        })
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    }

    /**
     * An assistant timer belongs to a device, not an entity, and only the
     * registry joins the two. Cached per entity, and a failed lookup is dropped
     * so the next press tries again rather than inheriting an outage.
     */
    #deviceIdFor(entityId: string): Promise<string | undefined> {
        const known = this.#devices.get(entityId)
        if (known) return known
        const lookup = this.#request({type: 'config/entity_registry/get', entity_id: entityId})
            .then((result) => (result as EntityRegistryEntry | null)?.device_id ?? undefined)
        this.#devices.set(entityId, lookup)
        void lookup.then((deviceId) => {
            if (deviceId === undefined) this.#devices.delete(entityId)
        }, () => this.#devices.delete(entityId))
        return lookup
    }

    patch(entityId: string, state: string, attributes: Record<string, unknown>): void {
        const current = this.#store.get(entityId)
        if (!current) return
        if (this.#store.set({entity_id: entityId, state, attributes: {...current.attributes, ...attributes}})) {
            this.#onStateChange()
        }
    }

    connect(): void {
        const socket = new this.#WebSocketImpl(this.url)
        this.#socket = socket
        socket.on('message', (raw: RawData) => this.receive(raw))
        socket.on('close', () => {
            if (this.#socket !== socket) return
            this.#socket = null
            this.#authenticated = false
            this.#forgetSubscription()
            this.#failPending(new Error('the Home Assistant connection closed'))
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
            for (const eventType of this.#eventListeners.keys()) this.#subscribeEvent(eventType)
            this.#subscribeEntities()
            this.#onStateChange()
            return
        }

        if (message.type === 'result') {
            const waiting = message.id === undefined ? undefined : this.#pending.get(message.id)
            if (waiting && message.id !== undefined) {
                this.#pending.delete(message.id)
                if (message.success === false) waiting.reject(new Error(JSON.stringify(message.result)))
                else waiting.resolve(message.result)
                return
            }
            if (message.success === false) {
                this.#logger.error('Home Assistant rejected a request', message.result)
            }
            return
        }

        if (message.type === 'event') {
            if (this.#entitiesSubscriptionId !== 0 && message.id === this.#entitiesSubscriptionId) {
                this.#applyEntityFeed(message.event ?? {})
                return
            }
            const eventType = message.event?.event_type
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

    #request(payload: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = this.#send(payload)
            if (id === 0) reject(new Error('not connected to Home Assistant'))
            else this.#pending.set(id, {resolve, reject})
        })
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

    #applyEntityFeed(feed: EntityFeed): void {
        let changed = false
        if (feed.a !== undefined) {
            const added = decodeAdded(feed.a)
            // The first block of a subscription is the whole set, so it replaces
            // the cache rather than merging into what the last one left.
            if (this.#primed) {
                for (const entity of added) changed = this.#store.set(entity) || changed
            } else {
                this.#store.replace(added)
                this.#primed = true
                changed = true
            }
        }
        for (const entity of decodeChanged(feed.c, (id) => this.#store.get(id))) {
            changed = this.#store.set(entity) || changed
        }
        for (const entityId of decodeRemoved(feed.r)) changed = this.#store.remove(entityId) || changed
        // Music Assistant re-reports a playing track constantly; a diff that
        // moves nothing a key draws must not cost a repaint.
        if (changed) this.#onStateChange()
    }

    #failPending(error: Error): void {
        const waiting = [...this.#pending.values()]
        this.#pending.clear()
        for (const request of waiting) request.reject(error)
    }

    #forgetSubscription(): void {
        this.#entitiesSubscriptionId = 0
        this.#subscribedIds = new Set()
        this.#primed = false
    }

    #subscribeEntities(): void {
        this.#entitiesQueued = false
        if (!this.#authenticated) return
        const wanted = [...this.#store.watched()].sort()
        if (sameIds(wanted, this.#subscribedIds)) return
        if (this.#entitiesSubscriptionId !== 0) {
            this.#send({type: 'unsubscribe_events', subscription: this.#entitiesSubscriptionId})
        }
        this.#forgetSubscription()
        if (wanted.length === 0) {
            this.#store.clear()
            this.#onStateChange()
            return
        }
        const id = this.#send({type: 'subscribe_entities', entity_ids: wanted})
        if (id === 0) return
        this.#entitiesSubscriptionId = id
        this.#subscribedIds = new Set(wanted)
    }

    // Coalesces the churn a page change produces: unmounting six tiles and
    // mounting six more should replace the subscription once, with the set the
    // new page actually settled on.
    #queueEntities(): void {
        if (this.#entitiesQueued || !this.#authenticated) return
        this.#entitiesQueued = true
        setTimeout(() => this.#subscribeEntities(), 0).unref()
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
        intent: (name, _data, deviceEntity) => {
            logger.log(`no Home Assistant configured; dropped ${name} for ${deviceEntity}`)
        },
        patch: () => {
        },
        watch: () => () => {
        },
        listen: () => () => {
        },
    }
}
