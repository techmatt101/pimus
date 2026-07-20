// The XVF3800 vendor-control protocol and its USB transport. Keeping this
// separate from respeaker.mts draws the line between how LED commands reach the
// hardware and which appearance the voice state asks for.
//
// The protocol constants and the 2886:001a device match are dictated by the
// XMOS firmware; preserve them when changing LED behaviour.

import type { LedDevice, LedStateSpec, UsbControlDevice, UsbDeviceFinder } from '../types.mjs'

export const EFFECTS = Object.freeze({ off: 0, breath: 1, rainbow: 2, single: 3, doa: 4, ring: 5 })

export type EffectName = keyof typeof EFFECTS
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

/** Clamps a value into the single byte the vendor protocol accepts. */
export const clampByte = (value: number): number =>
  Math.max(0, Math.min(255, Math.round(Number(value))))

const isEffectName = (value: string): value is EffectName => Object.hasOwn(EFFECTS, value)

export function rgb(value: string): number {
  const parsed = Number.parseInt(String(value).replace(/^#/, ''), 16)
  return Number.isFinite(parsed) ? parsed & 0xFFFFFF : 0
}

export function encodePayload(dataType: DataType, values: number[]): Buffer {
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
  private findDevice: UsbDeviceFinder | null
  private device: UsbControlDevice | null = null

  constructor({ vendorId, productId, findDevice = null }: Xvf3800Options) {
    this.vendorId = vendorId
    this.productId = productId
    this.findDevice = findDevice
  }

  async connect(): Promise<UsbControlDevice> {
    if (!this.findDevice) {
      // Loaded lazily so tests and LED-free deployments never open libusb.
      // findByIds returns the full usb.Device; narrow it to the vendor-control
      // surface this class actually uses.
      const { findByIds } = await import('usb')
      this.findDevice = findByIds as unknown as UsbDeviceFinder
    }
    const device = this.findDevice(this.vendorId, this.productId)
    if (!device) {
      throw new Error(`ReSpeaker ${this.vendorId.toString(16).padStart(4, '0')}:${this.productId.toString(16).padStart(4, '0')} not found`)
    }
    device.open()
    device.timeout = 8000
    this.device = device
    return device
  }

  async write(name: CommandName, values: number[]): Promise<void> {
    const device = this.device ?? await this.connect()
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
      try { this.device?.close() } catch {}
      this.device = null
      throw error
    }
  }

  async apply(spec: LedStateSpec, brightness: number, speed: number): Promise<void> {
    const requestedEffect = String(spec.effect || 'off').toLowerCase()
    const effect: EffectName = isEffectName(requestedEffect) ? requestedEffect : 'single'
    await this.write('LED_BRIGHTNESS', [brightness])
    await this.write('LED_SPEED', [speed])
    await this.write('LED_COLOR', [rgb(spec.color || '#000000')])
    if (effect === 'doa') {
      await this.write('LED_DOA_COLOR', [rgb(spec.color || '#000000'), rgb(spec.accent || '#00bcd4')])
    } else if (effect === 'ring') {
      // XVF3800 ring mode reads a separate colour for each of its 12 LEDs.
      // The current config exposes one colour, so fill the entire ring with it.
      await this.write('LED_RING_COLOR', Array(12).fill(rgb(spec.color || '#000000')))
    }
    await this.write('LED_EFFECT', [EFFECTS[effect]])
  }
}
