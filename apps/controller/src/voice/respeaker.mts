// Maps voice state to a ReSpeaker LED appearance. The vendor protocol and USB
// transport live in xvf3800-device.mts; this module only decides which
// appearance the current state should show.

import { clampByte, Xvf3800Device } from './xvf3800-device.mjs'
import type { LedDevice, LedStateSpec, LvaMessage, ReSpeakerConfig } from '../types.mjs'

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
