// Shapes shared across controller modules. The configuration types mirror
// ansible/roles/smartamp/templates/controller.json.j2; change both together.

import type { Image } from '@napi-rs/canvas'

/**
 * A declarative control-surface action. A `Binding` (streamdeck/bindings.mts)
 * pairs one with the behaviour that runs it; the catalog
 * (actions/catalog.mts) validates it and describes its key feedback.
 */
export interface Action {
  type: 'noop' | 'lva' | 'audio' | 'webhook' | 'ha'
  command?: string
  /** Named audio route for `audio` actions; absent means the master volume. */
  source?: string
  /** Home Assistant webhook identifier for `webhook` actions. */
  id?: string
  /** Home Assistant entity id for `ha` actions, e.g. `fan.office_ceiling`. */
  entity?: string
  /** Extra service data for `ha` actions, merged into the call. */
  data?: Record<string, unknown>
}

/**
 * The Stream Deck deployment flag from controller.json. Whether a unit drives a
 * deck is a per-device choice (`streamdeck_enabled` in inventory); the layout
 * itself is compiled in, see streamdeck/layout.mts.
 *
 * The compiled layout's own shape — pages, the fixed tile grid, and the tile
 * classes that render each key — lives in streamdeck/grid.mts and
 * streamdeck/tiles/, since those hold rendering behaviour rather than plain
 * configuration data.
 */
export interface StreamDeckDeployment {
  enabled: boolean
}

/**
 * Which appearance each voice state shows is compiled into the controller at
 * voice/led-states.mts, exactly as the deck layout is; deployment carries only
 * the flag, the device match, and the room's brightness.
 */
export interface ReSpeakerConfig {
  enabled: boolean
  vendor_id: number
  product_id: number
  brightness: number
}

/**
 * Ducking needs no tuning here: the level and fade live in the audio manager's
 * own configuration, and the request travels over the control socket in
 * `audio_socket`.
 */
export interface DuckingConfig {
  enabled: boolean
}

/**
 * The remote-tile WebSocket server (remote/server.mts): another computer on
 * the LAN pushes key faces onto the deck's REMOTE page and receives presses
 * back. This is the controller's one inbound listener, so it stays off unless
 * both the flag and the shared token are set.
 */
export interface RemoteConfig {
  enabled: boolean
  port: number
  /**
   * Read from `REMOTE_TILES_TOKEN` in the Pi's secrets file rather than from
   * controller.json, and filled in by `loadConfig`; see `config.mts`.
   */
  token: string
}

/**
 * Home Assistant connection details. The controller reads entity state and
 * calls services over the WebSocket API, so unlike the write-only `webhook`
 * action this needs a long-lived access token.
 */
export interface HomeAssistantConfig {
  enabled: boolean
  /** Base URL of the Home Assistant instance, e.g. `http://homeassistant.local:8123`. */
  url: string
  /**
   * Read from `HOME_ASSISTANT_TOKEN` in the Pi's secrets file rather than from
   * controller.json, and filled in by `loadConfig`; see `config.mts`.
   */
  token: string
}

/** One entity's last known state, in the shape Home Assistant reports it. */
export interface HomeAssistantEntity {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
}

/**
 * The slice of Home Assistant the control surface needs: read an entity, call a
 * service, and be told when a watched entity changes. Tiles depend on this
 * rather than the concrete client, so tests inject a plain object and a
 * deployment with no Home Assistant configured injects an offline stand-in
 * (home-assistant/client.mts).
 */
export interface HomeAssistantService {
  /** True while the socket is authenticated. Tiles show unknown state otherwise. */
  readonly connected: boolean
  /** The last known state of an entity, or undefined while it is unknown. */
  entity(entityId: string): HomeAssistantEntity | undefined
  /** Call `<domain>.<service>` against one entity, with optional extra data. */
  call(domain: string, service: string, entityId: string, data?: Record<string, unknown>): void
  /**
   * Report changes to any of `entityIds`. Returns an unsubscribe function; a
   * mounted tile watches only what it draws and drops the watch on unmount.
   */
  watch(entityIds: readonly string[], listener: () => void): () => void
  /**
   * Report Home Assistant events of one `event_type`, with the event's data.
   * This is the push direction: an automation fires an event and the deck reacts
   * without anything here polling or owning an entity for it (see
   * home-assistant/notifications.mts). Returns an unsubscribe function.
   */
  listen(eventType: string, listener: (data: Record<string, unknown>) => void): () => void
}

/**
 * A message pushed from Home Assistant for the touch strip to show — the
 * doorbell, a finished washing machine. Automations fire these; nothing here
 * polls for them, and nothing about the message needs an entity to exist.
 */
export interface Notification {
  /** Short heading, e.g. `FRONT DOOR`. */
  title: string
  message: string
  /** Banner background colour. */
  color: string
  /** When the strip started showing it, for the draining time bar. */
  shownAt: number
  /** When it stops showing. */
  expiresAt: number
}

/**
 * One key face pushed over the remote-tile socket. The image arrives as a PNG
 * and is decoded when it is accepted (remote/server.mts), so a repaint only
 * ever draws a ready image; a face may also be just a colour and a label.
 */
export interface RemoteTileFace {
  label: string
  color: string
  image?: Image
}

/**
 * The slice of the remote-tile server a RemoteTile key reads and drives.
 * Depending on this rather than the concrete server keeps the tile free of the
 * socket lifecycle and lets tests hand it a plain object.
 */
export interface RemoteTileFeed {
  /** The face pushed for a REMOTE-page slot, or undefined while it is empty. */
  tile(slot: number): RemoteTileFace | undefined
  /** Report a press back to whichever client owns the slot's face. */
  press(slot: number): void
}

/**
 * The slice of the notification queue the touch strip reads. Depending on this
 * rather than the concrete NotificationCenter keeps the strip free of the Home
 * Assistant subscription and lets tests hand it a plain object.
 */
export interface NotificationFeed {
  /**
   * The notification to show at `now`, or undefined when none is live. Expiry
   * is evaluated against the instant passed in, so a repaint decides what to
   * draw without depending on when a timer happened to fire.
   */
  current(now: number): Notification | undefined
  /** Drop whatever is showing, because it was acknowledged on the strip. */
  dismiss(): void
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
  home_assistant?: HomeAssistantConfig
  remote?: RemoteConfig
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
 * The subset of the LVA client the voice actions need. Depending on this
 * instead of LvaClient keeps the catalog and tiles free of a circular import
 * and lets tests pass a plain recording object.
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
  /**
   * Whether the Stream Deck's panel is lit. False switches the keys and the
   * touch strip off and stops every tile animation, because the room is empty
   * (streamdeck/sleep.mts). Nothing else sleeps with it: the wake word, the
   * ReSpeaker ring, and background playback all keep running.
   */
  awake: boolean
  /**
   * The Stream Deck panel's own brightness, 0 to 100. Display state like the
   * rest of this model: the BrightnessTile mutates it and notifies, and the
   * renderer (streamdeck/renderer.mts) is what re-lights the panel. A sleeping
   * panel goes to 0 regardless, and comes back to this level.
   */
  brightness: number
}

/** Route enablement mirrored from the audio manager's control socket. */
export interface AudioState {
  sources: Record<string, boolean | undefined>
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

/**
 * XVF3800 firmware LED effect codes. The values are dictated by the XMOS
 * firmware behind the 2886:001a vendor-control protocol; preserve them when
 * changing LED behaviour. `Doa` is the firmware's direction-of-arrival mode:
 * it lights the LEDs facing the detected voice.
 */
export enum LedEffect {
  Off = 0,
  Breath = 1,
  Rainbow = 2,
  Solid = 3,
  Doa = 4,
  Ring = 5,
}

/** The XVF3800 ring has twelve LEDs; LED_RING_COLOR takes one colour each. */
export const LED_COUNT = 12

/**
 * One fully resolved LED write: everything the vendor protocol needs, with
 * colours packed as 0xRRGGBB numbers. Animated appearances resolve to a fresh
 * frame per tick, and the device writes only the commands whose values
 * changed since the last frame.
 */
export interface LedFrame {
  effect: LedEffect
  brightness: number
  speed: number
  color: number
  /** One colour per LED, exactly LED_COUNT entries, for the Ring effect. */
  ring?: readonly number[]
  /** Base and highlight colours for the Doa effect. */
  direction?: { base: number; highlight: number }
}

/** The LED transport the ReSpeaker controller drives. */
export interface LedDevice {
  apply(frame: LedFrame): Promise<void>
}
