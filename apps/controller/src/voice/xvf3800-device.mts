// The protocol constants and the 2886:001a device match are dictated by the
// XMOS firmware; preserve them when changing LED behaviour.

import type {
    LedDevice,
    LedFrame,
    UsbControlDevice,
    UsbDeviceFinder,
    VoiceSensing,
    VoiceSensor,
} from '../types.mjs'

export type DataType = 'uint8' | 'uint32'
export type CommandName =
    | 'LED_EFFECT'
    | 'LED_BRIGHTNESS'
    | 'LED_SPEED'
    | 'LED_COLOR'
    | 'LED_DOA_COLOR'
    | 'LED_RING_COLOR'

// The whole LED command set is recorded because it is the device's protocol;
// only brightness, the ring colours, and the effect are written, because the
// rest configure firmware effects this controller no longer asks for.
/** XVF3800 vendor controls as [resourceId, command, payload type]. */
export const COMMANDS: Readonly<Record<CommandName, readonly [number, number, DataType]>> =
    Object.freeze({
        LED_EFFECT: [20, 12, 'uint8'],
        LED_BRIGHTNESS: [20, 13, 'uint8'],
        LED_SPEED: [20, 15, 'uint8'],
        LED_COLOR: [20, 16, 'uint32'],
        LED_DOA_COLOR: [20, 17, 'uint32'],
        LED_RING_COLOR: [20, 19, 'uint32'],
    } as const)

export type ReadName = 'AEC_SPENERGY_VALUES' | 'AUDIO_MGR_SELECTED_AZIMUTHS'

/** Readable DSP values as [resourceId, command, float count]. */
export const READS: Readonly<Record<ReadName, readonly [number, number, number]>> =
    Object.freeze({
        AEC_SPENERGY_VALUES: [33, 80, 4],
        AUDIO_MGR_SELECTED_AZIMUTHS: [35, 11, 2],
    } as const)

// A read sets the command's high bit and answers with a status byte ahead of
// the payload. A status of anything but ready means the servicer has not
// produced this command's answer yet, and the bytes behind it are the previous
// command's, so they must be discarded rather than parsed. The servicer only
// advances every few milliseconds, so retries are paced rather than immediate:
// hammering it returns the same not-ready answer every time.
const READ_BIT = 0x80
const STATUS_READY = 0
const READ_RETRY_MILLISECONDS = 3
const READ_ATTEMPTS = 6

// AEC_SPENERGY_VALUES reports one energy per beam and
// AUDIO_MGR_SELECTED_AZIMUTHS one azimuth per beam; the auto-select beam is the
// one that follows whoever is speaking, and the processed azimuth is the DSP's
// own choice between the fixed beams, NaN while neither holds speech.
const AUTO_SELECT_BEAM = 3
const PROCESSED_AZIMUTH = 0

const delay = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))

export const clampByte = (value: number): number =>
    Math.max(0, Math.min(255, Math.round(Number(value))))

export function encodePayload(dataType: DataType, values: readonly number[]): Buffer {
    if (dataType === 'uint8') return Buffer.from(values.map(clampByte))
    const payload = Buffer.alloc(values.length * 4)
    values.forEach((value, index) => payload.writeUInt32LE(Number(value) >>> 0, index * 4))
    return payload
}

export interface Xvf3800Options {
    vendorId: number
    productId: number
    findDevice?: UsbDeviceFinder | null
}

export class Xvf3800Device implements LedDevice, VoiceSensor {
    readonly vendorId: number
    readonly productId: number
    #findDevice: UsbDeviceFinder | null
    #device: UsbControlDevice | null = null
    #written = new Map<CommandName, string>()
    // Reads answer over two exchanges with the servicer, so a frame written
    // between them would be handed back as the read's payload.
    #transfers: Promise<unknown> = Promise.resolve()

    constructor({vendorId, productId, findDevice = null}: Xvf3800Options) {
        this.vendorId = vendorId
        this.productId = productId
        this.#findDevice = findDevice
    }

    async connect(): Promise<UsbControlDevice> {
        if (!this.#findDevice) {
            // Loaded lazily so tests and LED-free deployments never open libusb.
            const {findByIds} = await import('usb')
            this.#findDevice = findByIds as unknown as UsbDeviceFinder
        }
        const device = this.#findDevice(this.vendorId, this.productId)
        if (!device) {
            throw new Error(`ReSpeaker ${this.vendorId.toString(16).padStart(4, '0')}:${this.productId.toString(16).padStart(4, '0')} not found`)
        }
        device.open()
        device.timeout = 8000
        this.#device = device
        // A fresh handle may be a re-enumerated device in an unknown state, so
        // nothing it was previously sent can be assumed to still be set.
        this.#written.clear()
        return device
    }

    async write(name: CommandName, values: readonly number[]): Promise<void> {
        const [resourceId, command, dataType] = COMMANDS[name]
        const payload = encodePayload(dataType, values)
        await this.#transfer(0x40, command, resourceId, payload)
    }

    async read(name: ReadName): Promise<number[] | null> {
        const [resourceId, command, count] = READS[name]
        for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
            if (attempt > 0) await delay(READ_RETRY_MILLISECONDS)
            const answer = await this.#transfer(0xC0, command | READ_BIT, resourceId, count * 4 + 1)
            if (!answer || answer.length < count * 4 + 1) continue
            if (answer[0] !== STATUS_READY) continue
            return Array.from({length: count}, (_, index) => answer.readFloatLE(1 + index * 4))
        }
        return null
    }

    apply(frame: LedFrame): Promise<void> {
        return this.#queued(() => this.#applyFrame(frame))
    }

    /**
     * A power-cycled device rebooted into firmware defaults without the stale
     * handle ever erroring — nothing transfers while the shown face is
     * unchanged — so the handle and the delivered-command cache are dropped
     * and the next frame reconnects and rewrites everything.
     */
    reattach(): void {
        void this.#queued(async () => {
            try {
                this.#device?.close()
            } catch {
            }
            this.#device = null
            this.#written.clear()
        })
    }

    sense(): Promise<VoiceSensing> {
        return this.#queued(() => this.#senseVoice())
    }

    async #transfer(
        requestType: number,
        command: number,
        resourceId: number,
        payload: Buffer | number,
    ): Promise<Buffer | null> {
        const device = this.#device ?? await this.connect()
        try {
            return await new Promise<Buffer | null>((resolve, reject) => {
                device.controlTransfer(requestType, 0, command, resourceId, payload,
                    (error: unknown, answer?: Buffer | number) => {
                        if (error) reject(error instanceof Error ? error : new Error(String(error)))
                        else resolve(Buffer.isBuffer(answer) ? answer : null)
                    })
            })
        } catch (error) {
            try {
                this.#device?.close()
            } catch {
            }
            this.#device = null
            this.#written.clear()
            throw error
        }
    }

    /** Serialises whole operations, so no write lands inside a read's exchange. */
    #queued<T>(action: () => Promise<T>): Promise<T> {
        const result = this.#transfers.then(action, action)
        this.#transfers = result.catch(() => undefined)
        return result
    }

    /** Writes a command only when its values differ from the last delivery. */
    async #writeChanged(name: CommandName, values: readonly number[]): Promise<void> {
        const signature = values.join(',')
        if (this.#written.get(name) === signature) return
        await this.write(name, values)
        this.#written.set(name, signature)
    }

    async #applyFrame(frame: LedFrame): Promise<void> {
        await this.#writeChanged('LED_BRIGHTNESS', [clampByte(frame.brightness)])
        if (frame.ring) await this.#writeChanged('LED_RING_COLOR', frame.ring)
        // The effect goes last so the firmware never briefly runs a new effect
        // with the previous frame's colours.
        await this.#writeChanged('LED_EFFECT', [frame.effect])
    }

    async #senseVoice(): Promise<VoiceSensing> {
        const energies = await this.read('AEC_SPENERGY_VALUES')
        const azimuths = await this.read('AUDIO_MGR_SELECTED_AZIMUTHS')
        const energy = energies?.[AUTO_SELECT_BEAM]
        const azimuth = azimuths?.[PROCESSED_AZIMUTH]
        return {
            direction: azimuth !== undefined && Number.isFinite(azimuth) ? azimuth : null,
            energy: energy !== undefined && Number.isFinite(energy) ? Math.max(0, energy) : 0,
        }
    }
}
