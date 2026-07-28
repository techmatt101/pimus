// A stand-in for the Linux Voice Assistant peripheral WebSocket. The real
// LvaClient connects to it over a loopback socket, so reconnects, the snapshot
// handshake, and every command the catalog sends are exercised for real.
//
// It also plays back a plausible pipeline (wake -> listening -> thinking ->
// speaking -> idle) so ducking, the ReSpeaker LEDs, and the key indicators all
// move on their own without anyone speaking to a microphone.

import {type WebSocket, WebSocketServer} from 'ws'

import type {LogCategory, PlaygroundBus} from './bus.mjs'
import type {LvaEventData} from '../../controller/src/types.mjs'

/** How the simulated pipeline advances after `start_listening`, in order. */
const PIPELINE: ReadonlyArray<readonly [delay: number, event: string]> = [
    [0, 'wake_word_detected'],
    [400, 'listening'],
    [2200, 'thinking'],
    [3600, 'tts_speaking'],
    [6000, 'tts_finished'],
]

/** Commands whose only effect is an immediate event echoed back. */
const ECHO: Readonly<Record<string, string>> = {
    resume_media_player: 'media_player_playing',
    pause_media_player: 'media_player_paused',
    stop_media_player: 'media_player_idle',
    stop_timer_ringing: 'idle',
}

export interface FakeLvaOptions {
    bus: PlaygroundBus
    /** Whether an assist command plays the scripted pipeline back. */
    simulate?: boolean
}

export class FakeLvaServer {
    simulate: boolean
    private readonly bus: PlaygroundBus
    private readonly server: WebSocketServer
    // Subscribed in the constructor: the socket can bind before start() is
    // awaited, and a listener added afterwards would never see the event.
    private readonly listening: Promise<void>
    private readonly clients = new Set<WebSocket>()
    private timers: NodeJS.Timeout[] = []
    private muted = false
    private volume = 1

    constructor({bus, simulate = true}: FakeLvaOptions) {
        this.bus = bus
        this.simulate = simulate
        this.server = new WebSocketServer({host: '127.0.0.1', port: 0})
        this.listening = new Promise((resolve) => this.server.once('listening', () => resolve()))
        this.server.on('connection', (socket) => this.accept(socket))
    }

    get connected(): boolean {
        return this.clients.size > 0
    }

    /** Resolves with the loopback URI once the socket is listening. */
    async start(): Promise<string> {
        await this.listening
        const address = this.server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        return `ws://127.0.0.1:${port}`
    }

    /** Pushes an event to the controller exactly as upstream LVA would. */
    send(event: string, data: LvaEventData = {}, category: LogCategory = 'voice'): void {
        if (event === 'muted') this.muted = Boolean(data.muted)
        const payload = JSON.stringify({event, data: this.stamp(data)})
        this.bus.log(category, 'in', `event ${event}`, Object.keys(data).length ? JSON.stringify(data) : undefined)
        for (const client of this.clients) client.send(payload)
    }

    /**
     * The launcher adapter on the Pi stamps every timer reading with the instant
     * it was taken and whether the timer is running; mirror it so the deck's
     * countdown is exercised the way the real one drives it.
     */
    private stamp(data: LvaEventData): LvaEventData {
        if (data.seconds_left === undefined) return data
        return {is_active: true, ...data, emitted_at: Date.now() / 1000}
    }

    dropConnections(): void {
        this.bus.log('lva', 'note', 'dropping the voice socket')
        for (const client of this.clients) client.terminate()
    }

    close(): void {
        this.cancelPipeline()
        for (const client of this.clients) client.terminate()
        this.server.close()
    }

    private accept(socket: WebSocket): void {
        this.clients.add(socket)
        this.bus.log('lva', 'note', 'controller connected to the voice assistant')
        socket.on('message', (raw) => this.receive(String(raw)))
        socket.on('close', () => {
            this.clients.delete(socket)
            this.bus.log('lva', 'note', 'controller disconnected from the voice assistant')
        })
        socket.on('error', () => {
        })
        // LVA opens with the current peripheral state; this is what moves the
        // controller out of DISCONNECTED.
        socket.send(JSON.stringify({
            event: 'snapshot',
            data: {muted: this.muted, volume: this.volume, ha_connected: true},
        }))
    }

    private receive(raw: string): void {
        let message: { command?: unknown; data?: unknown }
        try {
            message = JSON.parse(raw) as { command?: unknown; data?: unknown }
        } catch {
            this.bus.log('lva', 'out', 'unparseable command', raw)
            return
        }
        const command = String(message.command ?? '')
        this.bus.log('lva', 'out', `command ${command}`, message.data ? JSON.stringify(message.data) : undefined)
        this.apply(command)
    }

    private apply(command: string): void {
        if (command === 'mute_mic' || command === 'unmute_mic') {
            this.send('muted', {muted: command === 'mute_mic'})
            return
        }
        if (command === 'stop_pipeline') {
            this.cancelPipeline()
            this.send('idle')
            return
        }
        const echo = ECHO[command]
        if (echo) {
            this.send(echo)
            return
        }
        if (command === 'start_listening') {
            this.runPipeline()
            return
        }
        // Anything else is a command the controller forwards verbatim; upstream
        // would act on it, and the playground just records that it arrived.
        this.bus.log('lva', 'note', `no simulation for "${command}"`)
    }

    /** Plays the scripted assist pipeline, replacing any run already going. */
    runPipeline(): void {
        this.cancelPipeline()
        if (!this.simulate) {
            this.send('wake_word_detected')
            return
        }
        for (const [delay, event] of PIPELINE) {
            const timer = setTimeout(() => this.send(event), delay)
            timer.unref()
            this.timers.push(timer)
        }
    }

    cancelPipeline(): void {
        for (const timer of this.timers) clearTimeout(timer)
        this.timers = []
    }
}
