// A stand-in for smartamp-audio-manager's Unix control socket. It speaks the
// same newline-delimited JSON protocol, so AudioManagerClient's optimistic
// cache, its re-assert on reconnect, and the duck request that the kernel
// releases when the socket closes all behave exactly as they do on the Pi.
//
// It reconciles no PipeWire graph, of course: a route here is just a boolean.

import fs from 'node:fs'
import net from 'node:net'

import type {PlaygroundBus} from './bus.mjs'

/** The routes the real manager owns; anything else is rejected the same way. */
const ROUTES = ['aux', 'usb'] as const

export interface FakeAudioManagerOptions {
    bus: PlaygroundBus
    socketPath: string
}

export class FakeAudioManager {
    readonly socketPath: string
    sources: Record<string, boolean | undefined> = {aux: false, usb: true}
    musicVolume = 40
    voiceVolume = 60
    outputMuted = false

    private readonly bus: PlaygroundBus
    private readonly server: net.Server
    private readonly connections = new Set<net.Socket>()
    private readonly ducking = new Set<net.Socket>()
    private readonly metering = new Set<net.Socket>()
    private meterTimer: NodeJS.Timeout | null = null

    constructor({bus, socketPath}: FakeAudioManagerOptions) {
        this.bus = bus
        this.socketPath = socketPath
        this.server = net.createServer((socket) => this.accept(socket))
    }

    /** True while any live connection holds a duck request, as on the Pi. */
    get ducked(): boolean {
        return this.ducking.size > 0
    }

    get connected(): boolean {
        return this.connections.size > 0
    }

    async start(): Promise<void> {
        fs.rmSync(this.socketPath, {force: true})
        await new Promise<void>((resolve) => this.server.listen(this.socketPath, () => resolve()))
    }

    dropConnections(): void {
        this.bus.log('audio', 'note', 'dropping the audio manager socket')
        for (const socket of this.connections) socket.destroy()
    }

    /** Synchronous so it can finish inside a signal handler before exit. */
    close(): void {
        this.stopMetering()
        for (const socket of this.connections) socket.destroy()
        this.server.close()
        fs.rmSync(this.socketPath, {force: true})
    }

    private accept(socket: net.Socket): void {
        this.connections.add(socket)
        this.bus.log('audio', 'note', 'controller connected to the audio manager')
        let buffer = ''
        socket.on('data', (chunk) => {
            buffer += String(chunk)
            for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
                const line = buffer.slice(0, index).trim()
                buffer = buffer.slice(index + 1)
                if (line) this.receive(socket, line)
            }
        })
        socket.on('error', () => {
        })
        socket.on('close', () => {
            this.connections.delete(socket)
            // The manager ties a duck request to its connection; closing the socket
            // is what restores background audio after a controller crash.
            if (this.ducking.delete(socket)) this.bus.log('duck', 'note', 'duck released with the socket')
            if (this.metering.delete(socket) && this.metering.size === 0) this.stopMetering()
            this.bus.log('audio', 'note', 'controller disconnected from the audio manager')
        })
    }

    private receive(socket: net.Socket, line: string): void {
        let message: Record<string, unknown>
        try {
            message = JSON.parse(line) as Record<string, unknown>
        } catch {
            this.bus.log('audio', 'out', 'unparseable command', line)
            return
        }
        const command = String(message.command ?? '')
        this.bus.log('audio', 'out', `command ${command}`, line)

        if (command === 'get-state') {
            this.sendState(socket)
        } else if (command === 'set-source') {
            this.setSource(socket, String(message.name ?? ''), String(message.state ?? ''))
        } else if (command === 'set-sources') {
            const requested = message.sources
            if (typeof requested === 'object' && requested !== null && !Array.isArray(requested)) {
                for (const [name, enabled] of Object.entries(requested as Record<string, unknown>)) {
                    if (this.knows(name)) this.sources[name] = Boolean(enabled)
                }
            }
            this.broadcastState()
        } else if (command === 'set-voice-volume') {
            const percent = message.percent
            if (typeof percent !== 'number' || percent < 0 || percent > 100) {
                this.reject(socket, 'set-voice-volume needs a percent between 0 and 100')
                return
            }
            this.voiceVolume = Math.round(percent)
            this.bus.log('audio', 'note', `voice volume set to ${this.voiceVolume}%`)
            this.broadcastState()
        } else if (command === 'set-music-volume') {
            const percent = message.percent
            if (typeof percent !== 'number' || percent < 0 || percent > 100) {
                this.reject(socket, 'set-music-volume needs a percent between 0 and 100')
                return
            }
            this.musicVolume = Math.round(percent)
            this.bus.log('audio', 'note', `music volume set to ${this.musicVolume}%`)
            this.broadcastState()
        } else if (command === 'set-output-mute') {
            const muted = message.muted
            if (typeof muted !== 'boolean') {
                this.reject(socket, 'set-output-mute needs a boolean muted')
                return
            }
            this.outputMuted = muted
            this.bus.log('audio', 'note', `output sink ${muted ? 'muted' : 'unmuted'}`)
            this.broadcastState()
        } else if (command === 'set-duck') {
            const active = Boolean(message.active)
            if (active) this.ducking.add(socket)
            else this.ducking.delete(socket)
            this.bus.log('duck', 'note', active ? 'background audio ducked' : 'background audio restored')
        } else if (command === 'set-voice-meter') {
            const active = message.active
            if (typeof active !== 'boolean') {
                this.reject(socket, 'set-voice-meter needs a boolean active')
                return
            }
            if (active) this.metering.add(socket)
            else this.metering.delete(socket)
            this.bus.log('audio', 'note', `voice metering ${active ? 'started' : 'stopped'}`)
            if (this.metering.size > 0) this.startMetering()
            else this.stopMetering()
        } else {
            this.reject(socket, `unknown command "${command}"`)
        }
    }

    private setSource(socket: net.Socket, name: string, state: string): void {
        if (!this.knows(name)) {
            this.reject(socket, `unknown source "${name}"`)
            return
        }
        if (state === 'toggle') this.sources[name] = !this.sources[name]
        else if (state === 'on' || state === 'off') this.sources[name] = state === 'on'
        else {
            this.reject(socket, `unknown state "${state}"`)
            return
        }
        this.broadcastState()
    }

    private knows(name: string): boolean {
        return (ROUTES as readonly string[]).includes(name)
    }

    private reject(socket: net.Socket, error: string): void {
        socket.write(`${JSON.stringify({event: 'error', error})}\n`)
    }

    // The real manager measures the voice bus monitor; here the envelope is
    // synthesised at the same rate, so the ring's speaking effect is driven by
    // exactly the message stream the Pi sends.
    private startMetering(): void {
        if (this.meterTimer) return
        const started = Date.now()
        this.meterTimer = setInterval(() => {
            const seconds = (Date.now() - started) / 1000
            const syllables = (Math.sin(seconds * Math.PI * 2 * 3.2) + 1) / 2
            const phrase = Math.max(0, Math.sin(seconds * Math.PI * 2 * 0.28))
            const level = Math.min(1, syllables ** 1.6 * (0.35 + 0.75 * phrase))
            const event = `${JSON.stringify({event: 'voice_level', level: Number(level.toFixed(3))})}\n`
            for (const socket of this.metering) socket.write(event)
        }, 40)
        this.meterTimer.unref()
    }

    private stopMetering(): void {
        if (this.meterTimer) clearInterval(this.meterTimer)
        this.meterTimer = null
    }

    private sendState(socket: net.Socket): void {
        socket.write(`${JSON.stringify({
            event: 'state',
            sources: this.sources,
            music_volume: this.musicVolume,
            voice_volume: this.voiceVolume,
            output_muted: this.outputMuted,
        })}\n`)
    }

    private broadcastState(): void {
        for (const socket of this.connections) this.sendState(socket)
    }
}
