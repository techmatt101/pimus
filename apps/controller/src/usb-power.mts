import fs from 'node:fs'

import {logger} from './log.mjs'

const log = logger('usb-power')

// The kernel's per-port disable attribute both cuts VBUS and forbids
// re-enumeration, which uhubctl's bare power-off could not: the hub driver
// re-powered the port within a second of the disconnect. Which ports carry the
// deck and the ReSpeaker is the board's business, so they arrive in the
// deployed configuration beside the permissions Ansible granted on them.
const RETRY_MILLISECONDS = 30_000

type Write = (path: string, value: string) => Promise<void>

const writeAttribute: Write = (path, value) => fs.promises.writeFile(path, value)

export interface UsbPowerOptions {
    enabled: boolean
    ports: string[]
    write?: Write
    errors?: Pick<Console, 'error'>
}

export class UsbPower {
    #applied: boolean | null = null
    #queue: Promise<void> = Promise.resolve()
    #lastErrorMessage: string | null = null
    #failedAt = 0
    readonly #enabled: boolean
    readonly #ports: string[]
    readonly #write: Write
    readonly #errors: Pick<Console, 'error'>

    constructor({enabled, ports, write = writeAttribute, errors = console}: UsbPowerOptions) {
        this.#enabled = enabled
        this.#ports = ports
        this.#write = write
        this.#errors = errors
    }

    set(powered: boolean): void {
        if (!this.#enabled || this.#applied === powered) return
        if (this.#lastErrorMessage !== null && Date.now() - this.#failedAt < RETRY_MILLISECONDS) return
        this.#applied = powered
        // Serialised so an off issued mid-wake cannot overtake its own on.
        this.#queue = this.#queue.then(async () => {
            for (const port of this.#ports) {
                try {
                    await this.#write(port, powered ? '0' : '1')
                } catch (error) {
                    // Forgotten so a later pass retries rather than trusting a
                    // state that never took; every model change would retry, so
                    // the attempts are spaced and only a changed failure logs.
                    this.#applied = null
                    this.#failedAt = Date.now()
                    const message = error instanceof Error ? error.message : String(error)
                    if (message !== this.#lastErrorMessage) {
                        this.#lastErrorMessage = message
                        this.#errors.error(`usb power ${powered ? 'on' : 'off'} failed at ${port}`, error)
                    }
                    return
                }
            }
            this.#lastErrorMessage = null
            log.info(`USB ports ${powered ? 'powered' : 'unpowered'}`)
        })
    }
}
