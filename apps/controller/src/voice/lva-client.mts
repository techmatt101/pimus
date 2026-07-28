import WebSocket, {type RawData} from 'ws'

import {applyLvaEvent, changesPipeline} from '../state.mjs'
import {logger} from '../log.mjs'
import type {ControlState, LvaMessage, LvaSender} from '../types.mjs'

const log = logger('voice')

// mpv holds 0.8s of output buffer, so a reply keeps playing out of the voice
// bus for about 0.6s after LVA reports it finished (measured on this device).
// Applying the event then ends the speaking ring, the voice key, and the duck
// mid-word, so it is held back to land with the audio instead.
const PLAYOUT_MILLISECONDS = 700

export interface LvaClientOptions {
    uri: string
    state: ControlState
    onStateChange?: () => void
    onOpen?: () => unknown
    onEvent?: (message: LvaMessage) => unknown
    onDisconnect?: () => unknown
    reconnectMilliseconds?: number
    playoutMilliseconds?: number
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
    readonly #playoutMilliseconds: number
    readonly #WebSocketImpl: typeof WebSocket
    readonly #logger: Pick<Console, 'log' | 'error'>
    #socket: WebSocket | null = null
    #reconnectTimer: NodeJS.Timeout | null = null
    #playoutTimer: NodeJS.Timeout | null = null
    #playerStopped = false

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
                    playoutMilliseconds = PLAYOUT_MILLISECONDS,
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
        this.#playoutMilliseconds = playoutMilliseconds
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
            this.#dropHeldEvent()
            this.state.assist = 'DISCONNECTED'
            Promise.resolve(this.#onDisconnect()).catch((error: unknown) => this.#logger.error('voice disconnect hook failed', error))
            this.#onStateChange()
            this.scheduleReconnect()
        })
        socket.on('error', () => {
        })
    }

    receive(raw: RawData): void {
        const message = this.#parse(raw)
        if (!message) return
        // A pipeline that has moved on abandons the ending it was holding;
        // the socket's other traffic is unrelated and passes it by.
        if (changesPipeline(message.event)) this.#dropHeldEvent()
        if (this.#awaitsPlayout(message)) this.#holdForPlayout(message)
        else this.#apply(message)
    }

    #parse(raw: RawData): LvaMessage | null {
        try {
            return JSON.parse(raw.toString()) as LvaMessage
        } catch (error) {
            this.#logger.error('invalid voice event', error)
            return null
        }
    }

    /**
     * Whether the sound of a reply outlives the event that ended it, which it
     * does whenever mpv ran the reply out: LVA answers as soon as the file
     * ends, an output buffer before the last of it is heard. Cancelling is
     * exempt, because stopping the player discards that buffer with it.
     */
    #awaitsPlayout(message: LvaMessage): boolean {
        if (message.event !== 'tts_finished' && message.event !== 'idle') return false
        return this.state.assist === 'TTS_SPEAKING' && !this.#playerStopped
    }

    #holdForPlayout(message: LvaMessage): void {
        this.#playoutTimer = setTimeout(() => {
            this.#playoutTimer = null
            this.#apply(message)
        }, this.#playoutMilliseconds)
        this.#playoutTimer.unref()
    }

    #dropHeldEvent(): void {
        if (this.#playoutTimer) clearTimeout(this.#playoutTimer)
        this.#playoutTimer = null
    }

    #apply(message: LvaMessage): void {
        if (message.event === 'tts_speaking') this.#playerStopped = false
        applyLvaEvent(this.state, message)
        Promise.resolve(this.#onEvent(message)).catch((error: unknown) => this.#logger.error('voice event hook failed', error))
        this.#onStateChange()
    }

    send(command: string, data?: Record<string, unknown>): boolean {
        const socket = this.#socket
        if (socket?.readyState !== this.#WebSocketImpl.OPEN) return false
        log.debug('send', command, data ? JSON.stringify(data) : '')
        socket.send(JSON.stringify({command, ...(data ? {data} : {})}))
        if (command === 'stop_pipeline') this.#playerStopped = true
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
