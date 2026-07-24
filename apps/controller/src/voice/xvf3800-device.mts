// The protocol constants and the 2886:001a device match are dictated by the
// XMOS firmware; preserve them when changing LED behaviour.

import type {LedDevice, LedFrame, UsbControlDevice, UsbDeviceFinder} from '../types.mjs'

export type DataType = 'uint8' | 'uint32'
export type CommandName =
    | 'LED_EFFECT'
    | 'LED_BRIGHTNESS'
    | 'LED_SPEED'
    | 'LED_COLOR'
    | 'LED_DOA_COLOR'
    | 'LED_RING_COLOR'

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

export class Xvf3800Device implements LedDevice {
    readonly vendorId: number
    readonly productId: number
    #findDevice: UsbDeviceFinder | null
    #device: UsbControlDevice | null = null
    #written = new Map<CommandName, string>()

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
        const device = this.#device ?? await this.connect()
        const [resourceId, command, dataType] = COMMANDS[name]
        const payload = encodePayload(dataType, values)
        try {
            await new Promise<void>((resolve, reject) => {
                device.controlTransfer(0x40, 0, command, resourceId, payload, (error: unknown) => {
                    if (error) reject(error instanceof Error ? error : new Error(String(error)))
                    else resolve()
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

    /** Writes a command only when its values differ from the last delivery. */
    async #writeChanged(name: CommandName, values: readonly number[]): Promise<void> {
        const signature = values.join(',')
        if (this.#written.get(name) === signature) return
        await this.write(name, values)
        this.#written.set(name, signature)
    }

    async apply(frame: LedFrame): Promise<void> {
        await this.#writeChanged('LED_BRIGHTNESS', [clampByte(frame.brightness)])
        await this.#writeChanged('LED_SPEED', [clampByte(frame.speed)])
        await this.#writeChanged('LED_COLOR', [frame.color])
        if (frame.direction) {
            await this.#writeChanged('LED_DOA_COLOR', [frame.direction.base, frame.direction.highlight])
        }
        if (frame.ring) await this.#writeChanged('LED_RING_COLOR', frame.ring)
        // The effect goes last so the firmware never briefly runs a new effect
        // with the previous frame's colours.
        await this.#writeChanged('LED_EFFECT', [frame.effect])
    }
}
