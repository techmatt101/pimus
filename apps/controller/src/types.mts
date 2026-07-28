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
     * Run an intent as the device behind `deviceEntity` — the path to anything
     * Home Assistant keeps per device rather than as an entity, such as the
     * assistant timers a satellite owns.
     */
    intent(name: string, data: Record<string, unknown>, deviceEntity: string): void

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
    id?: string
    name?: string
    total_seconds?: number
    seconds_left?: number
    /** Added by the launcher adapter; absent on a stock LVA. */
    is_active?: boolean
    /** Seconds since the epoch, added by the launcher adapter. */
    emitted_at?: number
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

/**
 * The assistant timer the amp is running, whether it was set by voice or from
 * the deck. `endsAt` is absolute so a countdown survives the socket replaying a
 * reading taken before the controller connected; while paused it stands still
 * and `secondsLeft` is the reading.
 */
export interface TimerState {
    id: string
    name: string
    totalSeconds: number
    secondsLeft: number
    endsAt: number
    active: boolean
    ringing: boolean
}

/** Lit, dimmed as a warning that the room reads as empty, then dark. */
export type PanelState = 'lit' | 'dim' | 'off'

export interface ControlState {
    assist: string
    timer: TimerState | null
    muted: boolean
    volume: number
    outputMuted: boolean
    media: boolean
    /** Only the panel sleeps: the wake word, LED ring, and playback keep running. */
    panel: PanelState
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
        // An IN transfer passes the byte count to read where an OUT passes its
        // payload, and answers with the buffer libusb filled.
        data: Buffer | number,
        callback: (error: unknown, buffer?: Buffer | number) => void,
    ): unknown
}

export type UsbDeviceFinder = (vendorId: number, productId: number) => UsbControlDevice | undefined

/**
 * XVF3800 firmware LED effect codes, dictated by the XMOS firmware behind the
 * 2886:001a vendor-control protocol. The full set is recorded because it is the
 * device's, but the controller drives only `Ring` and `Off`: every face is drawn
 * here a frame at a time, which the firmware's own effects cannot express and
 * cannot be driven from live audio.
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
    /** One colour per LED, exactly LED_COUNT entries, for the Ring effect. */
    ring?: readonly number[]
}

export interface LedDevice {
    apply(frame: LedFrame): Promise<void>
}

/** What the XVF3800's own DSP reports about the voice reaching the array. */
export interface VoiceSensing {
    /**
     * Where the speaker is, in radians clockwise from the array's zero mark, or
     * null when the DSP reports no speech to place.
     */
    direction: number | null
    /** Speech energy as the DSP reports it: unbounded, and zero for silence. */
    energy: number
}

export interface VoiceSensor {
    sense(): Promise<VoiceSensing>
}

/**
 * The live levels an LED appearance may paint from, each already scaled to
 * 0..1. They are read at draw time rather than passed through the appearance so
 * the state map stays plain data.
 */
export interface LedSignals {
    /** How loudly the microphone array is hearing speech. */
    micLevel(): number

    /** Radians clockwise from the array's zero mark, or null with no speaker placed. */
    micDirection(): number | null

    /** How loudly the assistant is currently speaking. */
    speechLevel(): number
}
