import fs from 'node:fs'
import path from 'node:path'

import {logger} from './log.mjs'

const log = logger('power-button')

// struct input_event on a 64-bit kernel: sixteen bytes of timestamp, then
// type, code, and value.
const EVENT_BYTES = 24
const EV_KEY = 1
const KEY_POWER = 116
const KEY_PRESSED = 1

// The Pi 5's dedicated power button registers as this gpio-keys input device.
// systemd-logind is told to ignore it (HandlePowerKey=ignore, deployed by
// Ansible), or every press here would also be a graceful shutdown.
const DEVICE_NAME = 'pwr_button'
const RETRY_MILLISECONDS = 60_000

export interface PowerButtonOptions {
    onPress: () => void
    inputDir?: string
    sysDir?: string
    errors?: Pick<Console, 'error'>
}

export class PowerButton {
    #stream: fs.ReadStream | null = null
    #timer: NodeJS.Timeout | null = null
    #pending: Buffer = Buffer.alloc(0)
    #closed = false
    readonly #onPress: () => void
    readonly #inputDir: string
    readonly #sysDir: string
    readonly #errors: Pick<Console, 'error'>

    constructor({
        onPress,
        inputDir = '/dev/input',
        sysDir = '/sys/class/input',
        errors = console,
    }: PowerButtonOptions) {
        this.#onPress = onPress
        this.#inputDir = inputDir
        this.#sysDir = sysDir
        this.#errors = errors
    }

    start(): void {
        const device = this.#find()
        if (!device) {
            log.info('no power button input device; button wake is unavailable')
            return
        }
        const stream = fs.createReadStream(device)
        this.#stream = stream
        stream.on('data', (chunk) => this.#consume(chunk))
        stream.on('error', (error) => {
            this.#errors.error('power button read failed', error)
            this.#retry(stream)
        })
        stream.on('close', () => this.#retry(stream))
        log.info(`watching power button at ${device}`)
    }

    stop(): void {
        this.#closed = true
        if (this.#timer) clearTimeout(this.#timer)
        this.#timer = null
        this.#stream?.destroy()
        this.#stream = null
    }

    #find(): string | null {
        try {
            for (const entry of fs.readdirSync(this.#sysDir)) {
                if (!entry.startsWith('event')) continue
                const name = fs
                    .readFileSync(path.join(this.#sysDir, entry, 'device', 'name'), 'utf8')
                    .trim()
                if (name === DEVICE_NAME) return path.join(this.#inputDir, entry)
            }
        } catch {
            return null
        }
        return null
    }

    #consume(chunk: Buffer | string): void {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        this.#pending = this.#pending.length ? Buffer.concat([this.#pending, data]) : data
        let offset = 0
        for (; offset + EVENT_BYTES <= this.#pending.length; offset += EVENT_BYTES) {
            const type = this.#pending.readUInt16LE(offset + 16)
            const code = this.#pending.readUInt16LE(offset + 18)
            const value = this.#pending.readInt32LE(offset + 20)
            if (type === EV_KEY && code === KEY_POWER && value === KEY_PRESSED) this.#onPress()
        }
        this.#pending = this.#pending.subarray(offset)
    }

    #retry(stream: fs.ReadStream): void {
        if (this.#stream !== stream) return
        this.#stream.destroy()
        this.#stream = null
        this.#pending = Buffer.alloc(0)
        if (this.#closed || this.#timer) return
        this.#timer = setTimeout(() => {
            this.#timer = null
            this.start()
        }, RETRY_MILLISECONDS)
        this.#timer.unref()
    }
}
