import net from 'node:net'

import {logger} from '../log.mjs'
import type {AudioState} from '../types.mjs'

const log = logger('audio')

interface ManagerEvent {
    event?: string
    error?: string
    sources?: unknown
    usb_host?: unknown
}

export interface AudioManagerClientOptions {
    socketPath: string
    onStateChange?: () => void
    reconnectMilliseconds?: number
    connectSocket?: (path: string) => net.Socket
    logger?: Pick<Console, 'log' | 'error'>
}

/**
 * Mirrors the audio manager's route state over its Unix control socket. The
 * cache updates optimistically so the Stream Deck reacts instantly and keeps
 * working while the manager restarts; reconnecting re-asserts the cached
 * toggles so user choices survive a manager restart within a boot.
 */
export class AudioManagerClient {
    state: AudioState = {sources: {}}
    connected = false

    #duckActive = false
    #synced = false
    #buffer = ''
    #lastErrorMessage: string | null = null
    #socket: net.Socket | null = null
    #closed = false
    #reconnectTimer: NodeJS.Timeout | null = null
    readonly #socketPath: string
    readonly #onStateChange: () => void
    readonly #reconnectMilliseconds: number
    readonly #connectSocket: (path: string) => net.Socket
    readonly #logger: Pick<Console, 'log' | 'error'>

    constructor({
                    socketPath,
                    onStateChange = () => {
                    },
                    reconnectMilliseconds = 1000,
                    connectSocket = (path) => net.createConnection(path),
                    logger = console,
                }: AudioManagerClientOptions) {
        this.#socketPath = socketPath
        this.#onStateChange = onStateChange
        this.#reconnectMilliseconds = reconnectMilliseconds
        this.#connectSocket = connectSocket
        this.#logger = logger
    }

    connect(): void {
        if (this.#closed || this.#socket) return
        const socket = this.#connectSocket(this.#socketPath)
        this.#socket = socket
        this.#buffer = ''
        socket.on('connect', () => {
            this.connected = true
            this.#lastErrorMessage = null
            // A manager restart resets its routes to configured defaults, so
            // re-assert the cache; with no cache yet, adopt what the manager has.
            this.#write(this.#synced
                ? {command: 'set-sources', sources: this.state.sources}
                : {command: 'get-state'})
            // The manager ties a duck request to the connection that made it, so
            // a reconnect during a conversation has to ask again.
            if (this.#duckActive) this.#write({command: 'set-duck', active: true})
            this.#onStateChange()
        })
        socket.on('data', (chunk) => this.#receive(String(chunk)))
        // The once-per-second retry loop would flood the journal with the same
        // refusal: log only when the failure changes.
        socket.on('error', (error: Error) => {
            if (error.message !== this.#lastErrorMessage) {
                this.#lastErrorMessage = error.message
                this.#logger.error(`audio manager socket error: ${error.message}`)
            }
        })
        socket.on('close', () => {
            if (this.#socket !== socket) return
            this.#socket = null
            const wasConnected = this.connected
            this.connected = false
            if (wasConnected) this.#onStateChange()
            if (this.#closed) return
            this.#reconnectTimer = setTimeout(() => {
                this.#reconnectTimer = null
                this.connect()
            }, this.#reconnectMilliseconds)
        })
    }

    /**
     * Applies on/off/toggle to the local cache and forwards the resolved
     * absolute state, so a lost or replayed message can never invert a toggle.
     * Before the first authoritative state arrives the raw command is forwarded
     * for the manager to resolve against its own live state.
     */
    setSource(name: string, command: string): void {
        if (!this.#synced) {
            this.#write({command: 'set-source', name, state: command})
            return
        }
        const enabled = command === 'toggle' ? !this.state.sources[name] : command === 'on'
        if (this.state.sources[name] !== enabled) {
            this.state = {sources: {...this.state.sources, [name]: enabled}}
            this.#onStateChange()
        }
        this.#write({command: 'set-source', name, state: enabled ? 'on' : 'off'})
    }

    /**
     * The manager releases a duck request by itself if this socket closes, so a
     * crash cannot leave the background bus stuck at the duck level.
     */
    setDuck(active: boolean): void {
        if (this.#duckActive === active) return
        this.#duckActive = active
        this.#write({command: 'set-duck', active})
    }

    close(): void {
        this.#closed = true
        if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
        this.#reconnectTimer = null
        this.#socket?.destroy()
    }

    #write(message: Record<string, unknown>): void {
        if (!this.connected || !this.#socket) return
        log.debug('send', JSON.stringify(message))
        this.#socket.write(`${JSON.stringify(message)}\n`)
    }

    #receive(chunk: string): void {
        this.#buffer += chunk
        for (let index = this.#buffer.indexOf('\n'); index >= 0; index = this.#buffer.indexOf('\n')) {
            const line = this.#buffer.slice(0, index).trim()
            this.#buffer = this.#buffer.slice(index + 1)
            if (!line) continue
            let message: ManagerEvent
            try {
                message = JSON.parse(line) as ManagerEvent
            } catch {
                continue
            }
            if (message.event === 'state' && typeof message.sources === 'object'
                && message.sources !== null && !Array.isArray(message.sources)) {
                this.state = {
                    sources: {...(message.sources as AudioState['sources'])},
                    usbHost: message.usb_host === true,
                }
                this.#synced = true
                this.#onStateChange()
            } else if (message.event === 'error') {
                this.#logger.error(`audio manager rejected a command: ${message.error ?? 'unknown error'}`)
            }
        }
    }
}
