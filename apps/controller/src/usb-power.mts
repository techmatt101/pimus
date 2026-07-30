import {execFile} from 'node:child_process'

import {logger} from './log.mjs'

const log = logger('usb-power')

// The Pi 5's USB-A ports hang off two RP1 root hubs, which uhubctl addresses
// as locations "1" (USB 2) and "3" (USB 3); switching VBUS on both powers the
// Stream Deck and ReSpeaker down together.
const PI5_ROOT_HUBS = ['1', '3']

type Exec = (command: string, args: string[]) => Promise<void>

const execute: Exec = (command, args) =>
    new Promise((resolve, reject) => {
        execFile(command, args, (error) => (error ? reject(error) : resolve()))
    })

export interface UsbPowerOptions {
    enabled: boolean
    hubs?: string[]
    exec?: Exec
    errors?: Pick<Console, 'error'>
}

export class UsbPower {
    #applied: boolean | null = null
    #queue: Promise<void> = Promise.resolve()
    readonly #enabled: boolean
    readonly #hubs: string[]
    readonly #exec: Exec
    readonly #errors: Pick<Console, 'error'>

    constructor({enabled, hubs = PI5_ROOT_HUBS, exec = execute, errors = console}: UsbPowerOptions) {
        this.#enabled = enabled
        this.#hubs = hubs
        this.#exec = exec
        this.#errors = errors
    }

    set(powered: boolean): void {
        if (!this.#enabled || this.#applied === powered) return
        this.#applied = powered
        // Serialised so an off issued mid-wake cannot overtake its own on.
        this.#queue = this.#queue.then(async () => {
            for (const hub of this.#hubs) {
                try {
                    await this.#exec('uhubctl', ['-l', hub, '-a', powered ? 'on' : 'off'])
                } catch (error) {
                    // Forgotten so the next transition retries rather than
                    // trusting a state that never took.
                    this.#applied = null
                    this.#errors.error(`usb power ${powered ? 'on' : 'off'} failed on hub ${hub}`, error)
                    return
                }
            }
            log.info(`USB ports ${powered ? 'powered' : 'unpowered'}`)
        })
    }
}
