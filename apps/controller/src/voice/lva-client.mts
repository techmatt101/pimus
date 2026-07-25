import WebSocket, {type RawData} from 'ws'

import {applyLvaEvent} from '../state.mjs'
import {logger} from '../log.mjs'
import type {ControlState, LvaMessage, LvaSender} from '../types.mjs'

const log = logger('voice')

export interface LvaClientOptions {
    uri: string
    state: ControlState
    onStateChange?: () => void
    onOpen?: () => unknown
    onEvent?: (message: LvaMessage) => unknown
    onDisconnect?: () => unknown
    reconnectMilliseconds?: number
    WebSocketImpl?: typeof WebSocket
    logger?: Pick<Console, 'log' | 'error'>
}

export class LvaClient implements LvaSender {
    readonly uri: string
    readonly state: ControlState
    readonly #onStateChange: () => void
    readonly #onOpen: () => unknown
    readonly #onEvent: (message: LvaMessage) => unknown
    readonly #onDisconnect: () => unknown
    readonly #reconnectMilliseconds: number
    readonly #WebSocketImpl: typeof WebSocket
    readonly #logger: Pick<Console, 'log' | 'error'>
    #socket: WebSocket | null = null
    #reconnectTimer: NodeJS.Timeout | null = null

    constructor({
                    uri,
                    state,
                    onStateChange = () => {
                    },
                    onOpen = () => {
                    },
                    onEvent = () => {
                    },
                    onDisconnect = () => {
                    },
                    reconnectMilliseconds = 3000,
                    WebSocketImpl = WebSocket,
                    logger = console,
                }: LvaClientOptions) {
        this.uri = uri
        this.state = state
        this.#onStateChange = onStateChange
        this.#onOpen = onOpen
        this.#onEvent = onEvent
        this.#onDisconnect = onDisconnect
        this.#reconnectMilliseconds = reconnectMilliseconds
        this.#WebSocketImpl = WebSocketImpl
        this.#logger = logger
    }

    connect(): void {
        const socket = new this.#WebSocketImpl(this.uri)
        this.#socket = socket
        socket.on('open', () => {
            this.#logger.log('connected to voice assistant')
            Promise.resolve(this.#onOpen()).catch((error: unknown) => this.#logger.error('voice connection hook failed', error))
        })
        socket.on('message', (raw: RawData) => this.receive(raw))
        socket.on('close', () => {
            if (this.#socket !== socket) return
            this.#socket = null
            this.state.assist = 'DISCONNECTED'
            Promise.resolve(this.#onDisconnect()).catch((error: unknown) => this.#logger.error('voice disconnect hook failed', error))
            this.#onStateChange()
            this.scheduleReconnect()
        })
        socket.on('error', () => {
        })
    }

    receive(raw: RawData): void {
        try {
            const message = JSON.parse(raw.toString()) as LvaMessage
            applyLvaEvent(this.state, message)
            Promise.resolve(this.#onEvent(message)).catch((error: unknown) => this.#logger.error('voice event hook failed', error))
            this.#onStateChange()
        } catch (error) {
            this.#logger.error('invalid voice event', error)
        }
    }

    send(command: string, data?: Record<string, unknown>): boolean {
        const socket = this.#socket
        if (socket?.readyState !== this.#WebSocketImpl.OPEN) return false
        log.debug('send', command, data ? JSON.stringify(data) : '')
        socket.send(JSON.stringify({command, ...(data ? {data} : {})}))
        return true
    }

    scheduleReconnect(): void {
        if (this.#reconnectTimer) return
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null
            this.connect()
        }, this.#reconnectMilliseconds)
    }
}
