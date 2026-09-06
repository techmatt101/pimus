import net from 'node:net'

import {logger} from '../log.mjs'
import type {AudioState, SourceState} from '../types.mjs'

const log = logger('audio')

const ECHO_HOLD_MILLISECONDS = 2000

interface PendingLevel {
    level: number
    until: number
}

interface AudioEvent {
    event?: string
    error?: string
    sources?: unknown
    usb_playback?: unknown
    music_bus?: unknown
    voice_bus?: unknown
    output_volume?: unknown
    level?: unknown
}

function section(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

export interface AudioClientOptions {
    socketPath: string
    onStateChange?: () => void
    reconnectMilliseconds?: number
    connectSocket?: (path: string) => net.Socket
    clock?: () => number
    logger?: Pick<Console, 'log' | 'error'>
}

/**
 * Mirrors one audio service's state over its Unix control socket. The
 * cache updates optimistically so the Stream Deck reacts instantly and keeps
 * working while the manager restarts; reconnecting re-asserts the cached
 * toggles so user choices survive a manager restart within a boot.
 */
export class AudioClient {
    state: AudioState = {sources: {}, routesKnown: false}
    connected = false
    /** The metered voice-playback level, 0..1, and zero unless metering is on. */
    voiceLevel = 0

    #duckActive = false
    #standbyActive = false
    #voiceMeterActive = false
    #buffer = ''
    #lastErrorMessage: string | null = null
    #socket: net.Socket | null = null
    #closed = false
    #reconnectTimer: NodeJS.Timeout | null = null
    #pendingMusic: PendingLevel | null = null
    #pendingVoice: PendingLevel | null = null
    readonly #pendingTrims = new Map<string, PendingLevel>()
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
                }: AudioClientOptions) {
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
            // A manager restart resets its sources to configured defaults, so
            // re-assert the cache; with no cache yet, adopt what the manager has.
            if (this.state.routesKnown) {
                for (const [name, source] of Object.entries(this.state.sources)) {
                    if (source?.enabled !== undefined) {
                        this.#write({command: 'set-source-state', name, state: source.enabled ? 'on' : 'off'})
                    }
                }
                if (this.state.voiceVolume !== undefined) this.setVoiceVolume(this.state.voiceVolume)
                if (this.state.musicVolume !== undefined) this.setMusicVolume(this.state.musicVolume)
                if (this.state.volMuted !== undefined) this.setMusicMute(this.state.volMuted)
                for (const [name, source] of Object.entries(this.state.sources)) {
                    if (source?.trim !== undefined) this.setSourceTrim(name, source.trim)
                }
            } else {
                this.#write({command: 'get-state'})
            }
            // The manager ties a duck request, and a meter request, to the
            // connection that made it, so a reconnect during a conversation has
            // to ask again.
            if (this.#duckActive) this.#write({command: 'set-duck', active: true})
            if (this.#standbyActive) this.#write({command: 'set-standby', active: true})
            if (this.#voiceMeterActive) this.#write({command: 'set-voice-meter', active: true})
            this.#onStateChange()
        })
        socket.on('data', (chunk) => this.#receive(String(chunk)))
        // The once-per-second retry loop would flood the journal with the same
        // refusal: log only when the failure changes.
        socket.on('error', (error: Error) => {
            if (error.message !== this.#lastErrorMessage) {
                this.#lastErrorMessage = error.message
                this.#logger.error(`audio service ${this.#socketPath} socket error: ${error.message}`)
            }
        })
        socket.on('close', () => {
            if (this.#socket !== socket) return
            this.#socket = null
            const wasConnected = this.connected
            this.connected = false
            this.voiceLevel = 0
            this.state = {...this.state, usbPlayback: false}
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
    setSourceState(name: string, command: string): void {
        if (!this.state.routesKnown) {
            this.#write({command: 'set-source-state', name, state: command})
            return
        }
        const source = this.state.sources[name]
        const enabled = command === 'toggle' ? !source?.enabled : command === 'on'
        if (source?.enabled !== enabled) {
            this.state = {...this.state, sources: {...this.state.sources, [name]: {...source, enabled}}}
            this.#onStateChange()
        }
        this.#write({command: 'set-source-state', name, state: enabled ? 'on' : 'off'})
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

    /** Forwards the resolved absolute state, so a replayed message cannot invert a toggle. */
    setMusicMute(muted: boolean): void {
        if (this.state.volMuted !== muted) {
            this.state = {...this.state, volMuted: muted}
            this.#onStateChange()
        }
        this.#write({command: 'set-music-mute', muted})
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
     * Balances one input against the others, as a share of the music level.
     * Held only in the manager's memory, so a restart there comes back to the
     * configured trim and this cache re-asserts what was set since.
     */
    setSourceTrim(name: string, percent: number): void {
        const level = Math.round(Math.max(0, Math.min(100, percent)))
        const source = this.state.sources[name]
        if (source?.trim !== level) {
            this.state = {...this.state, sources: {...this.state.sources, [name]: {...source, trim: level}}}
            this.#onStateChange()
        }
        this.#pendingTrims.set(name, {level, until: this.#clock() + ECHO_HOLD_MILLISECONDS})
        this.#write({command: 'set-source-trim', name, percent: level})
    }

    /**
     * The manager releases a duck request by itself if this socket closes, so a
     * crash cannot leave the music bus stuck at the duck level.
     */
    setDuck(active: boolean): void {
        if (this.#duckActive === active) return
        this.#duckActive = active
        this.#write({command: 'set-duck', active})
    }

    /**
     * Reports the panel asleep, letting the manager's idle teardown skip its
     * silence timeout. Held against this socket exactly as a duck request is,
     * so a crash releases it and the bridges rebuild.
     */
    setStandby(active: boolean): void {
        if (this.#standbyActive === active) return
        this.#standbyActive = active
        this.#write({command: 'set-standby', active})
    }

    /**
     * Asks the manager to meter voice playback. It is held against this socket
     * exactly as a duck request is, so a crash cannot leave the capture running.
     */
    setVoiceMeter(active: boolean): void {
        if (this.#voiceMeterActive === active) return
        this.#voiceMeterActive = active
        // A level left standing would freeze the ring at whatever the last
        // syllable measured.
        if (!active) this.voiceLevel = 0
        this.#write({command: 'set-voice-meter', active})
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

    /**
     * The service's sources, each trim held at what was just asked for until
     * its own echo comes back, so a dial turn is not dragged backwards by a
     * state event that was already in flight.
     */
    #settleSources(reported: Record<string, unknown>): AudioState['sources'] {
        const sources: AudioState['sources'] = {}
        for (const [name, value] of Object.entries(reported)) {
            const entry = section(value)
            if (!entry) continue
            const settled = this.#settleLevel(this.#pendingTrims.get(name) ?? null, entry.trim, this.state.sources[name]?.trim)
            if (settled.pending) this.#pendingTrims.set(name, settled.pending)
            else this.#pendingTrims.delete(name)
            const source: SourceState = {}
            if (typeof entry.enabled === 'boolean') source.enabled = entry.enabled
            if (settled.level !== undefined) source.trim = settled.level
            sources[name] = source
        }
        return sources
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
            let message: AudioEvent
            try {
                message = JSON.parse(line) as AudioEvent
            } catch {
                continue
            }
            const sources = message.event === 'state' ? section(message.sources) : null
            if (sources) {
                const musicBus = section(message.music_bus)
                const voiceBus = section(message.voice_bus)
                const music = this.#settleLevel(this.#pendingMusic, musicBus?.volume, this.state.musicVolume)
                const voice = this.#settleLevel(this.#pendingVoice, voiceBus?.volume, this.state.voiceVolume)
                this.#pendingMusic = music.pending
                this.#pendingVoice = voice.pending
                this.state = {
                    sources: this.#settleSources(sources),
                    routesKnown: true,
                    usbPlayback: message.usb_playback === true,
                    ...(music.level !== undefined ? {musicVolume: music.level} : {}),
                    ...(voice.level !== undefined ? {voiceVolume: voice.level} : {}),
                    ...(typeof musicBus?.muted === 'boolean' ? {volMuted: musicBus.muted} : {}),
                    ...(typeof message.output_volume === 'number' ? {ampCeiling: message.output_volume} : {}),
                }
                this.#onStateChange()
            } else if (message.event === 'voice_level' && typeof message.level === 'number') {
                this.voiceLevel = Math.max(0, Math.min(1, message.level))
            } else if (message.event === 'error') {
                this.#logger.error(`audio service ${this.#socketPath} rejected a command: ${message.error ?? 'unknown error'}`)
            }
        }
    }
}
