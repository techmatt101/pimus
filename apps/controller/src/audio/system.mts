/** Combines independent audio services for the controls without proxying through the manager. */
import {AudioClient, type AudioClientOptions} from './client.mjs'
import type {AudioState} from '../types.mjs'

export interface AudioSystemOptions extends AudioClientOptions {
    usbSocketPath?: string
}

export class AudioSystem {
    readonly #manager: AudioClient
    readonly #usb: AudioClient | null

    constructor({usbSocketPath, ...options}: AudioSystemOptions) {
        this.#manager = new AudioClient(options)
        this.#usb = usbSocketPath
            ? new AudioClient({...options, socketPath: usbSocketPath})
            : null
    }

    get state(): AudioState {
        const manager = this.#manager.state
        const usb = this.#usb?.state
        return {
            ...manager,
            sources: {...manager.sources, ...usb?.sources},
            trims: {...manager.trims, ...usb?.trims},
            routesKnown: manager.routesKnown && (!usb || usb.routesKnown),
            usbPlayback: this.#usb?.connected === true && usb?.usbPlayback === true,
        }
    }

    /**
     * Whether every audio service this unit runs is answering. A room's sound
     * is only as healthy as the least of them, and one reading covers whatever
     * input services a deployment gains later.
     */
    get connected(): boolean {
        return this.#manager.connected && (this.#usb === null || this.#usb.connected)
    }
    get voiceLevel(): number { return this.#manager.voiceLevel }

    connect(): void {
        this.#manager.connect()
        this.#usb?.connect()
    }

    close(): void {
        this.#usb?.close()
        this.#manager.close()
    }

    setSourceState(name: string, command: string): void {
        if (name === 'usb') this.#usb?.setSourceState(name, command)
        else this.#manager.setSourceState(name, command)
    }

    setInputTrim(name: string, percent: number): void {
        if (name === 'usb') this.#usb?.setInputTrim(name, percent)
        else this.#manager.setInputTrim(name, percent)
    }

    setMusicVolume(percent: number): void { this.#manager.setMusicVolume(percent) }
    setMusicMute(muted: boolean): void { this.#manager.setMusicMute(muted) }
    setVoiceVolume(percent: number): void { this.#manager.setVoiceVolume(percent) }
    setDuck(active: boolean): void { this.#manager.setDuck(active) }
    setStandby(active: boolean): void { this.#manager.setStandby(active) }
    setVoiceMeter(active: boolean): void { this.#manager.setVoiceMeter(active) }
}
