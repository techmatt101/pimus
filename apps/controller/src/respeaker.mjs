import fs from 'node:fs'

export const EFFECTS = Object.freeze({ off: 0, breath: 1, rainbow: 2, single: 3, doa: 4, ring: 5 })
export const COMMANDS = Object.freeze({
  LED_EFFECT: [20, 12, 'uint8'],
  LED_BRIGHTNESS: [20, 13, 'uint8'],
  LED_SPEED: [20, 15, 'uint8'],
  LED_COLOR: [20, 16, 'uint32'],
  LED_DOA_COLOR: [20, 17, 'uint32'],
})

const CRITICAL_STATES = new Set(['muted', 'disconnected', 'pipeline_error', 'timer_ringing'])
const LIGHT_EFFECTS = ['Voice Assistant', 'Off', 'Breath', 'Rainbow', 'Single', 'DOA']
const LOCAL_MODES = ['voice', 'off', 'single', 'breath', 'rainbow', 'doa']

const clampByte = (value) => Math.max(0, Math.min(255, Math.round(Number(value))))

export function rgb(value) {
  const parsed = Number.parseInt(String(value).replace(/^#/, ''), 16)
  return Number.isFinite(parsed) ? parsed & 0xFFFFFF : 0
}

export function encodePayload(dataType, values) {
  if (dataType === 'uint8') return Buffer.from(values.map(clampByte))
  const payload = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => payload.writeUInt32LE(Number(value) >>> 0, index * 4))
  return payload
}

export class Xvf3800Device {
  constructor({ vendorId, productId, findDevice = null }) {
    this.vendorId = vendorId
    this.productId = productId
    this.findDevice = findDevice
    this.device = null
  }

  async connect() {
    if (!this.findDevice) ({ findByIds: this.findDevice } = await import('usb'))
    const device = this.findDevice(this.vendorId, this.productId)
    if (!device) {
      throw new Error(`ReSpeaker ${this.vendorId.toString(16).padStart(4, '0')}:${this.productId.toString(16).padStart(4, '0')} not found`)
    }
    device.open()
    device.timeout = 8000
    this.device = device
  }

  async write(name, values) {
    if (!this.device) await this.connect()
    const [resourceId, command, dataType] = COMMANDS[name]
    const payload = encodePayload(dataType, values)
    try {
      await new Promise((resolve, reject) => {
        this.device.controlTransfer(0x40, 0, command, resourceId, payload, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    } catch (error) {
      try { this.device?.close() } catch {}
      this.device = null
      throw error
    }
  }

  async apply(spec, brightness, speed) {
    const requestedEffect = String(spec.effect || 'off').toLowerCase()
    const effect = Object.hasOwn(EFFECTS, requestedEffect) ? requestedEffect : 'single'
    await this.write('LED_BRIGHTNESS', [brightness])
    await this.write('LED_SPEED', [speed])
    await this.write('LED_COLOR', [rgb(spec.color || '#000000')])
    if (effect === 'doa') {
      await this.write('LED_DOA_COLOR', [rgb(spec.color || '#000000'), rgb(spec.accent || '#00bcd4')])
    }
    await this.write('LED_EFFECT', [EFFECTS[effect]])
  }
}

export class ReSpeakerController {
  constructor({ config, device, logger = console }) {
    this.config = config
    this.device = device || new Xvf3800Device({
      vendorId: Number(config.vendor_id),
      productId: Number(config.product_id),
    })
    this.logger = logger
    this.stateFile = config.state_file
    this.assistState = 'disconnected'
    this.muted = false
    this.lastSignature = ''
    this.renderQueue = Promise.resolve()
    this.watchTimer = null
  }

  readLocal() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') this.logger.warn('Unable to read LED state', error)
      return { mode: 'voice', color: '#00bcd4' }
    }
  }

  writeLocal(state) {
    const temporary = `${this.stateFile}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
    fs.renameSync(temporary, this.stateFile)
  }

  desired() {
    const local = this.readLocal()
    const current = this.muted ? 'muted' : this.assistState
    if (CRITICAL_STATES.has(current) || (local.mode || 'voice') === 'voice') {
      const spec = { ...(this.config.states[current] || this.config.states.idle) }
      if (local.brightness !== undefined) spec.brightness = local.brightness
      return spec
    }
    return {
      effect: String(local.mode || 'off'),
      color: local.color || '#00bcd4',
      accent: '#ffffff',
      brightness: local.brightness ?? this.config.brightness ?? 64,
    }
  }

  render(force = false) {
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
      } catch (error) {
        // USB devices can be unplugged or re-enumerated; the next watch tick
        // retries and Xvf3800Device opens a fresh handle.
        this.logger.warn('Unable to update ReSpeaker LEDs', error)
      }
    })
    return this.renderQueue
  }

  start() {
    void this.render(true)
    this.watchTimer = setInterval(() => void this.render(), 500)
  }

  stop() {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
  }

  register(lva) {
    return lva.send('register_light', {
      name: this.config.light_name,
      object_id: this.config.light_object_id,
      effects: LIGHT_EFFECTS,
      supports_rgb: true,
      supports_brightness: true,
    })
  }

  setDisconnected() {
    this.assistState = 'disconnected'
    return this.render(true)
  }

  async command(command) {
    const state = this.readLocal()
    if (command === 'cycle') {
      const index = LOCAL_MODES.indexOf(state.mode || 'voice')
      state.mode = LOCAL_MODES[(index < 0 ? 0 : index + 1) % LOCAL_MODES.length]
    } else {
      state.mode = command
    }
    this.writeLocal(state)
    await this.render(true)
  }

  async handleEvent(message) {
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
    } else if (event === 'light_command' && data.object_id === this.config.light_object_id) {
      const effect = String(data.effect || 'Single')
      let mode = effect === 'Voice Assistant' ? 'voice' : effect.toLowerCase()
      if (data.state === false) mode = 'off'
      const red = clampByte(Number(data.red ?? 0) * 255)
      const green = clampByte(Number(data.green ?? 0.74) * 255)
      const blue = clampByte(Number(data.blue ?? 0.83) * 255)
      const brightness = clampByte(Number(data.brightness ?? 1) * 255)
      this.writeLocal({
        mode,
        color: `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`,
        brightness,
      })
    } else if (Object.hasOwn(this.config.states, event)) {
      this.assistState = String(event)
    } else if (event === 'tts_finished' || event === 'idle') {
      this.assistState = 'idle'
    } else if (event === 'timer_updated') {
      this.assistState = 'timer_ticking'
    }
    await this.render(true)
  }
}
