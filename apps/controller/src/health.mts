import {readFileSync} from 'node:fs'

import {logger} from './log.mjs'
import type {ControlModel} from './state.mjs'
import type {HealthState} from './types.mjs'

const log = logger('health')

const LOST_COLOR = '#b71c1c'

const BANNERS: ReadonlyArray<{ key: keyof HealthState; label: string }> = [
    {key: 'network', label: 'NETWORK'},
    {key: 'ha', label: 'HOME ASSISTANT'},
    {key: 'audio', label: 'AUDIO MANAGER'},
]

export function defaultRouteExists(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): boolean {
    try {
        return read('/proc/net/route')
            .split('\n')
            .slice(1)
            .some((line) => line.split('\t')[1] === '00000000')
    } catch {
        // Not Linux (the playground), so never report the network as down.
        return true
    }
}

export interface HealthSources {
    network(): boolean
    ha(): boolean
    audio(): boolean
    usbPlayback(): boolean
}

export interface HealthPoster {
    post(data: Record<string, unknown>): void
}

export interface HealthMonitorOptions {
    model: ControlModel
    sources: HealthSources
    notifications: HealthPoster
    intervalMilliseconds?: number
}

/**
 * Samples each subsystem, keeps `state.health` current for the strip's status
 * icons, and turns a loss into a strip banner. The first sample sets the icons
 * silently: a subsystem that is down at boot shows red rather than greeting
 * every start with a burst of "lost" banners. A recovery gets no banner — the
 * icon stopping its red flash is the whole message.
 */
export class HealthMonitor {
    readonly #model: ControlModel
    readonly #sources: HealthSources
    readonly #notifications: HealthPoster
    readonly #intervalMilliseconds: number
    #timer: NodeJS.Timeout | null = null
    #sampled = false

    constructor({model, sources, notifications, intervalMilliseconds = 5000}: HealthMonitorOptions) {
        this.#model = model
        this.#sources = sources
        this.#notifications = notifications
        this.#intervalMilliseconds = intervalMilliseconds
    }

    start(): void {
        if (this.#timer) return
        this.sample()
        this.#timer = setInterval(() => this.sample(), this.#intervalMilliseconds)
        this.#timer.unref()
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer)
        this.#timer = null
    }

    sample(): void {
        const next: HealthState = {
            network: this.#sources.network(),
            ha: this.#sources.ha(),
            audio: this.#sources.audio(),
            usbPlayback: this.#sources.usbPlayback(),
        }
        const previous = this.#model.state.health
        const changed = (Object.keys(next) as Array<keyof HealthState>).filter((key) => next[key] !== previous[key])
        const announce = this.#sampled
        this.#sampled = true
        if (changed.length === 0) return
        this.#model.state.health = next
        if (announce) {
            for (const {key, label} of BANNERS) {
                if (!changed.includes(key)) continue
                const up = next[key]
                log[up ? 'info' : 'warn'](label.toLowerCase(), up ? 'restored' : 'lost')
                if (up) continue
                this.#notifications.post({title: label, message: 'LOST', color: LOST_COLOR, seconds: 8})
            }
        }
        this.#model.notify()
    }
}
