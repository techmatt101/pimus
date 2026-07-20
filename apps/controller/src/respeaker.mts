import type {
  LedDevice,
  LedStateSpec,
  LvaMessage,
  ReSpeakerConfig,
  UsbControlDevice,
  UsbDeviceFinder,
} from './types.mjs'

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

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(Number(value))))

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

export interface ReSpeakerControllerOptions {
  config: ReSpeakerConfig
  device?: LedDevice
  voiceEnabled?: boolean
  now?: () => number
  warningIntervalMilliseconds?: number
  logger?: Pick<Console, 'warn'>
}

export class ReSpeakerController {
  readonly config: ReSpeakerConfig
  readonly device: LedDevice
  private readonly logger: Pick<Console, 'warn'>
  private readonly now: () => number
  private readonly warningIntervalMilliseconds: number
  private assistState = 'disconnected'
  private muted = false
  private lastSignature = ''
  private lastWarningAt = Number.NEGATIVE_INFINITY
  private lastWarningSignature = ''
  private renderQueue: Promise<void> = Promise.resolve()
  private watchTimer: NodeJS.Timeout | null = null

  constructor({
    config,
    device,
    voiceEnabled = true,
    now = Date.now,
    warningIntervalMilliseconds = 30_000,
    logger = console,
  }: ReSpeakerControllerOptions) {
    this.config = config
    this.device = device ?? new Xvf3800Device({
      vendorId: Number(config.vendor_id),
      productId: Number(config.product_id),
    })
    this.logger = logger
    this.now = now
    this.warningIntervalMilliseconds = warningIntervalMilliseconds
    // An LED-only installation has no LVA socket to transition away from the
    // disconnected state, so begin at the normal idle appearance instead.
    if (!voiceEnabled) this.assistState = 'idle'
  }

  desired(): LedStateSpec {
    const current = this.muted ? 'muted' : this.assistState
    return { ...(this.config.states[current] ?? this.config.states.idle) }
  }

  render(force = false): Promise<void> {
    this.renderQueue = this.renderQueue.then(async () => {
      const spec = this.desired()
      const signature = JSON.stringify(spec, Object.keys(spec).sort())
      if (!force && signature === this.lastSignature) return
      try {
        await this.device.apply(
          spec,
          clampByte(spec.brightness ?? this.config.brightness ?? 64),
          clampByte(this.config.speed ?? 2),
        )
        this.lastSignature = signature
        this.lastWarningSignature = ''
        this.lastWarningAt = Number.NEGATIVE_INFINITY
      } catch (error) {
        // USB devices can be unplugged or re-enumerated; the next watch tick
        // retries and Xvf3800Device opens a fresh handle.
        const warningSignature = String(error)
        const now = this.now()
        if (warningSignature !== this.lastWarningSignature
            || now - this.lastWarningAt >= this.warningIntervalMilliseconds) {
          this.logger.warn('Unable to update ReSpeaker LEDs', error)
          this.lastWarningSignature = warningSignature
          this.lastWarningAt = now
        }
      }
    })
    return this.renderQueue
  }

  start(): void {
    void this.render(true)
    // State changes arrive through handleEvent; this tick exists to retry USB
    // delivery after an unplug or enumeration failure.
    this.watchTimer = setInterval(() => void this.render(), 500)
  }

  stop(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
  }

  setDisconnected(): Promise<void> {
    this.assistState = 'disconnected'
    return this.render(true)
  }

  async handleEvent(message: LvaMessage | undefined): Promise<void> {
    const event = message?.event
    const data = message?.data || {}
    if (event === 'snapshot') {
      this.muted = Boolean(data.muted)
      this.assistState = data.ha_connected ? 'idle' : 'disconnected'
    } else if (event === 'muted') {
      this.muted = Boolean(data.muted)
      if (!this.muted) this.assistState = 'idle'
    } else if (event === 'zeroconf' && data.status === 'connected') {
      this.assistState = 'idle'
    } else if (event && Object.hasOwn(this.config.states, event)) {
      this.assistState = String(event)
    } else if ((event === 'media_player_paused' || event === 'media_player_idle')
        && this.assistState === 'media_player_playing') {
      this.assistState = 'idle'
    } else if (event === 'tts_finished' || event === 'idle') {
      this.assistState = 'idle'
    } else if (event === 'timer_updated') {
      this.assistState = 'timer_ticking'
    }
    await this.render(true)
  }
}
