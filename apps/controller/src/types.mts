// Shapes shared across controller modules. The configuration types mirror
// ansible/roles/smartamp/templates/controller.json.j2; change both together.

/** A configured control-surface action, as generated into controller.json. */
export interface Action {
  type: 'noop' | 'lva' | 'audio' | 'webhook'
  command?: string
  /** Named audio route for `audio` actions; absent means the master volume. */
  source?: string
  /** Home Assistant webhook identifier for `webhook` actions. */
  id?: string
}

export interface StreamDeckKey {
  label: string
  color: string
  action?: Action
}

export interface StreamDeckDial {
  label: string
  left?: Action
  right?: Action
  press?: Action
}

/**
 * The Stream Deck deployment flag from controller.json. Whether a unit drives a
 * deck is a per-device choice (`streamdeck_enabled` in inventory); the layout
 * itself is compiled in, see streamdeck/layout.mts.
 */
export interface StreamDeckDeployment {
  enabled: boolean
}

/** The compiled control surface: panel brightness and the key/dial bindings. */
export interface StreamDeckLayout {
  brightness: number
  keys: StreamDeckKey[]
  dials: StreamDeckDial[]
}

/** One LED appearance: an effect name plus its colours and brightness. */
export interface LedStateSpec {
  effect?: string
  color?: string
  accent?: string
  brightness?: number
}

/** Voice states map to LED appearances; `idle` is the required fallback. */
export interface ReSpeakerStates {
  idle: LedStateSpec
  [state: string]: LedStateSpec | undefined
}

export interface ReSpeakerConfig {
  enabled: boolean
  vendor_id: number
  product_id: number
  brightness: number
  speed: number
  states: ReSpeakerStates
}

/**
 * Ducking needs no tuning here: the level and fade live in the audio manager's
 * own configuration, and the request travels over the control socket in
 * `audio_socket`.
 */
export interface DuckingConfig {
  enabled: boolean
}

export interface ControllerConfig {
  voice_enabled: boolean
  lva_uri: string
  /** Unix control socket of the audio manager daemon. */
  audio_socket: string
  webhook_base?: string
  ducking?: DuckingConfig
  streamdeck?: StreamDeckDeployment
  respeaker?: ReSpeakerConfig
}

/** Fields the controller reads out of Linux Voice Assistant event payloads. */
export interface LvaEventData {
  muted?: boolean
  volume?: number
  ha_connected?: boolean
  status?: string
}

export interface LvaMessage {
  event?: string
  data?: LvaEventData
}

/**
 * The subset of the LVA client the action handler needs. Depending on this
 * instead of LvaClient keeps the module free of a circular import and lets
 * tests pass a plain recording object.
 */
export interface LvaSender {
  send(command: string, data?: Record<string, unknown>): void
}

/** Shared control-surface state rendered on the Stream Deck. */
export interface ControlState {
  assist: string
  muted: boolean
  volume: number
  outputMuted: boolean
  media: boolean
}

/** Route enablement mirrored from the audio manager's control socket. */
export interface AudioState {
  sources: Record<string, boolean | undefined>
}

/** A raw RGB image buffer built for Stream Deck keys and the LCD strip. */
export interface Bitmap {
  width: number
  height: number
  buffer: Buffer
}

/**
 * The narrow slice of the `usb` package's Device used for XVF3800 vendor
 * control transfers. Keeping it structural lets tests inject a fake device.
 */
export interface UsbControlDevice {
  timeout: number
  open(): void
  close(): void
  controlTransfer(
    bmRequestType: number,
    bRequest: number,
    wValue: number,
    wIndex: number,
    data: Buffer,
    callback: (error: unknown, buffer?: Buffer | number) => void,
  ): unknown
}

export type UsbDeviceFinder = (vendorId: number, productId: number) => UsbControlDevice | undefined

/** The LED transport the ReSpeaker controller drives. */
export interface LedDevice {
  apply(spec: LedStateSpec, brightness: number, speed: number): Promise<void>
}
