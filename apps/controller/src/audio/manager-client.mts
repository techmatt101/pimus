import net from 'node:net'

import {logger} from '../log.mjs'
import type {AudioState} from '../types.mjs'

const log = logger('audio')

const ECHO_HOLD_MILLISECONDS = 2000

interface PendingLevel {
    level: number
    until: number
}

interface ManagerEvent {
    event?: string
    error?: string
    sources?: unknown
    usb_playback?: unknown
    music_volume?: unknown
    voice_volume?: unknown
}

export interface AudioManagerClientOptions {
    socketPath: string
    onStateChange?: () => void
    reconnectMilliseconds?: number
    connectSocket?: (path: string) => net.Socket
    clock?: () => number
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
    #pendingMusic: PendingLevel | null = null
    #pendingVoice: PendingLevel | null = null
    readonly #socketPath: string
    readonly #onStateChange: () => void
    readonly #reconnectMilliseconds: number
    readonly #connectSocket: (path: string) => net.Socket
    readonly #clock: () => number
    readonly #logger: Pick<Console, 'log' | 'error'>

    constructor({
                    socketPath,
                    onStateChange = () => {
                    },
                    reconnectMilliseconds = 1000,
                    connectSocket = (path) => net.createConnection(path),
                    clock = Date.now,
                    logger = console,
                }: AudioManagerClientOptions) {
        this.#socketPath = socketPath
        this.#onStateChange = onStateChange
        this.#reconnectMilliseconds = reconnectMilliseconds
        this.#connectSocket = connectSocket
        this.#clock = clock
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
            if (this.#synced) {
                this.#write({command: 'set-sources', sources: this.state.sources})
                if (this.state.voiceVolume !== undefined) this.setVoiceVolume(this.state.voiceVolume)
                if (this.state.musicVolume !== undefined) this.setMusicVolume(this.state.musicVolume)
            } else {
                this.#write({command: 'get-state'})
            }
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
            this.state = {...this.state, sources: {...this.state.sources, [name]: enabled}}
            this.#onStateChange()
        }
        this.#write({command: 'set-source', name, state: enabled ? 'on' : 'off'})
    }

    setVoiceVolume(percent: number): void {
        const level = Math.round(Math.max(0, Math.min(100, percent)))
        if (this.state.voiceVolume !== level) {
            this.state = {...this.state, voiceVolume: level}
            this.#onStateChange()
        }
        this.#pendingVoice = {level, until: this.#clock() + ECHO_HOLD_MILLISECONDS}
        this.#write({command: 'set-voice-volume', percent: level})
    }

    setMusicVolume(percent: number): void {
        const level = Math.round(Math.max(0, Math.min(100, percent)))
        if (this.state.musicVolume !== level) {
            this.state = {...this.state, musicVolume: level}
            this.#onStateChange()
        }
        this.#pendingMusic = {level, until: this.#clock() + ECHO_HOLD_MILLISECONDS}
        this.#write({command: 'set-music-volume', percent: level})
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

    // The manager's own reconciles broadcast state while later volume commands
    // are still in flight, so a reported level walking the readout backwards is
    // ignored until it matches the pending target or the hold lapses; a real
    // host-slider move still wins once the hold has passed.
    #settleLevel(
        pending: PendingLevel | null,
        reported: unknown,
        cached: number | undefined,
    ): {level: number | undefined, pending: PendingLevel | null} {
        if (typeof reported !== 'number') return {level: cached, pending}
        if (pending && this.#clock() < pending.until) {
            if (reported === pending.level) return {level: reported, pending: null}
            return {level: cached, pending}
        }
        return {level: reported, pending: null}
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
                const music = this.#settleLevel(this.#pendingMusic, message.music_volume, this.state.musicVolume)
                const voice = this.#settleLevel(this.#pendingVoice, message.voice_volume, this.state.voiceVolume)
                this.#pendingMusic = music.pending
                this.#pendingVoice = voice.pending
                this.state = {
                    sources: {...(message.sources as AudioState['sources'])},
                    usbPlayback: message.usb_playback === true,
                    ...(music.level !== undefined ? {musicVolume: music.level} : {}),
                    ...(voice.level !== undefined ? {voiceVolume: voice.level} : {}),
                }
                this.#synced = true
                this.#onStateChange()
            } else if (message.event === 'error') {
                this.#logger.error(`audio manager rejected a command: ${message.error ?? 'unknown error'}`)
            }
        }
    }
}
