import type {Image} from '@napi-rs/canvas'

export interface Action {
    type: 'noop' | 'lva' | 'audio' | 'ha'
    command?: string
    /** Named audio route for `audio` actions; absent means the master volume. */
    source?: string
    entity?: string
    data?: Record<string, unknown>
}

export interface StreamDeckDeployment {
    enabled: boolean
}

export interface ReSpeakerConfig {
    enabled: boolean
    vendor_id: number
    product_id: number
    brightness: number
}

export interface DuckingConfig {
    enabled: boolean
}

export interface RemoteConfig {
    enabled: boolean
    port: number
    /** Not in controller.json: read from `REMOTE_TILES_TOKEN` in the Pi's secrets file by `loadConfig`. */
    token: string
}

export interface HomeAssistantConfig {
    enabled: boolean
    url: string
    /** Not in controller.json: read from `HOME_ASSISTANT_TOKEN` in the Pi's secrets file by `loadConfig`. */
    token: string
}

export interface HomeAssistantEntity {
    entity_id: string
    state: string
    attributes: Record<string, unknown>
}

export interface HomeAssistantService {
    readonly connected: boolean

    entity(entityId: string): HomeAssistantEntity | undefined

    call(domain: string, service: string, entityId: string, data?: Record<string, unknown>): void

    /**
     * Optimistically overwrite an entity's cached state so the key and strip move
     * the instant a command is issued, before Home Assistant echoes it back.
     * Merges onto the entity's current attributes; a no-op where nothing is cached.
     */
    patch(entityId: string, state: string, attributes: Record<string, unknown>): void

    /** Report changes to any of `entityIds`. Returns an unsubscribe function. */
    watch(entityIds: readonly string[], listener: () => void): () => void

    /** Report Home Assistant events of one `event_type`. Returns an unsubscribe function. */
    listen(eventType: string, listener: (data: Record<string, unknown>) => void): () => void
}

export interface Notification {
    title: string
    message: string
    color: string
    shownAt: number
    expiresAt: number
}

export interface RemoteTileFace {
    label: string
    color: string
    image?: Image
}

export interface RemoteTileFeed {
    tile(slot: number): RemoteTileFace | undefined

    press(slot: number): void
}

export interface NotificationFeed {
    /** Expiry is evaluated against the instant passed in, not a timer's firing. */
    current(now: number): Notification | undefined

    dismiss(): void
}

export interface ControllerConfig {
    voice_enabled: boolean
    lva_uri: string
    audio_socket: string
    ducking?: DuckingConfig
    streamdeck?: StreamDeckDeployment
    respeaker?: ReSpeakerConfig
    home_assistant?: HomeAssistantConfig
    remote?: RemoteConfig
}

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

export interface LvaSender {
    send(command: string, data?: Record<string, unknown>): void
}

export interface AudioControls {
    setVolume(command: string): unknown

    setSource(name: string, command: string): unknown

    setVoiceVolume(percent: number): unknown
}

export interface HealthState {
    network: boolean
    ha: boolean
    audio: boolean
    usbPlayback: boolean
}

export interface ControlState {
    assist: string
    muted: boolean
    volume: number
    outputMuted: boolean
    media: boolean
    /** Only the panel sleeps: the wake word, LED ring, and playback keep running. */
    awake: boolean
    brightness: number
    health: HealthState
}

export interface AudioState {
    sources: Record<string, boolean | undefined>
    usbPlayback?: boolean
    /** The music level in percent; unknown until the manager's first state event. */
    musicVolume?: number
    /** The voice bus level in percent; unknown until the manager's first state event. */
    voiceVolume?: number
    /** Whether the output sink is muted; unknown until the manager's first state event. */
    outputMuted?: boolean
}

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

/**
 * XVF3800 firmware LED effect codes, dictated by the XMOS firmware behind the
 * 2886:001a vendor-control protocol. `Doa` is the firmware's
 * direction-of-arrival mode: it lights the LEDs facing the detected voice.
 */
export enum LedEffect {
    Off = 0,
    Breath = 1,
    Rainbow = 2,
    Solid = 3,
    Doa = 4,
    Ring = 5,
}

export const LED_COUNT = 12

export interface LedFrame {
    effect: LedEffect
    brightness: number
    speed: number
    /** Packed 0xRRGGBB. */
    color: number
    /** One colour per LED, exactly LED_COUNT entries, for the Ring effect. */
    ring?: readonly number[]
    direction?: { base: number; highlight: number }
}

export interface LedDevice {
    apply(frame: LedFrame): Promise<void>
}
