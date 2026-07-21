// A stand-in for Home Assistant. It implements the same narrow
// HomeAssistantService the tiles depend on, so everything above that boundary —
// the entity watches, the mount/unmount lifecycle, the service calls the
// catalog composes, the unknown-state faces — is the real controller code.
//
// It skips the WebSocket entirely: the protocol client has its own tests, and
// what the playground is for is seeing the keys behave. In exchange it can do
// what a real house does and a socket fake could not conveniently — apply the
// service calls to its own entities, so pressing the fan key actually turns the
// fan on, the timer really counts down, and the temperature drifts.

import type { PlaygroundBus } from './bus.mjs'
import type { HomeAssistantEntity, HomeAssistantService } from '../../controller/src/types.mjs'

/**
 * The entities apps/controller/src/streamdeck/layout.mts names. Changing an id
 * there without changing it here is exactly the mistake the playground should
 * show, as a key that draws unknown state.
 */
const INITIAL: Record<string, { state: string; attributes?: Record<string, unknown> }> = {
  'media_player.office_amp': { state: 'paused', attributes: { shuffle: false, volume_level: 0.4 } },
  'light.office': { state: 'on', attributes: { brightness: 160 } },
  'fan.office_ceiling': { state: 'off' },
  'cover.office_blinds': { state: 'open' },
  'switch.office_pc': { state: 'off' },
  'timer.office': { state: 'idle', attributes: { duration: '0:05:00', remaining: '0:05:00' } },
  'sensor.office_temperature': { state: '21.4', attributes: { unit_of_measurement: '°C' } },
  'weather.home': { state: 'partlycloudy', attributes: { temperature: 14, humidity: 71 } },
  'scene.office_bright': { state: 'unknown' },
  'scene.office_work': { state: 'unknown' },
  'scene.office_warm': { state: 'unknown' },
  'scene.office_off': { state: 'unknown' },
}

/** Weather conditions cycled by the browser control, in a plausible order. */
export const CONDITIONS = ['sunny', 'partlycloudy', 'cloudy', 'rainy', 'pouring', 'lightning-rainy', 'snowy', 'fog']

export class FakeHomeAssistant implements HomeAssistantService {
  connected = true

  private readonly bus: PlaygroundBus
  private readonly entities = new Map<string, HomeAssistantEntity>()
  private readonly watchers = new Set<{ ids: ReadonlySet<string>; listener: () => void }>()
  private countdown: NodeJS.Timeout | null = null

  constructor(bus: PlaygroundBus) {
    this.bus = bus
    for (const [entityId, seed] of Object.entries(INITIAL)) {
      this.entities.set(entityId, { entity_id: entityId, state: seed.state, attributes: { ...seed.attributes } })
    }
  }

  entity(entityId: string): HomeAssistantEntity | undefined {
    return this.entities.get(entityId)
  }

  watch(entityIds: readonly string[], listener: () => void): () => void {
    const watcher = { ids: new Set(entityIds), listener }
    this.watchers.add(watcher)
    return () => {
      this.watchers.delete(watcher)
    }
  }

  call(domain: string, service: string, entityId: string, data?: Record<string, unknown>): void {
    this.bus.log('home-assistant', 'out', `${domain}.${service} ${entityId}`, data ? JSON.stringify(data) : undefined)
    if (!this.connected) return
    this.apply(domain, service, entityId, data ?? {})
  }

  /** Drop everything, so the tiles are seen drawing their unknown faces. */
  setConnected(connected: boolean): void {
    this.connected = connected
    this.bus.log('home-assistant', 'note', connected ? 'reconnected' : 'connection lost')
    for (const watcher of [...this.watchers]) watcher.listener()
  }

  /** Change an entity from the browser, as something else in the house would. */
  put(entityId: string, state: string, attributes: Record<string, unknown> = {}): void {
    const previous = this.entities.get(entityId)
    this.entities.set(entityId, {
      entity_id: entityId,
      state,
      attributes: { ...previous?.attributes, ...attributes },
    })
    this.bus.log('home-assistant', 'in', `${entityId} -> ${state}`)
    for (const watcher of [...this.watchers]) if (watcher.ids.has(entityId)) watcher.listener()
  }

  /** Every entity, for the browser's Home Assistant panel. */
  snapshot(): Record<string, { state: string; attributes: Record<string, unknown> }> {
    // Reporting nothing while disconnected keeps the panel honest about what
    // the controller can actually see.
    if (!this.connected) return {}
    return Object.fromEntries(
      [...this.entities].map(([id, entity]) => [id, { state: entity.state, attributes: entity.attributes }]),
    )
  }

  close(): void {
    if (this.countdown) clearInterval(this.countdown)
    this.countdown = null
  }

  /** What the house does in response to a service call. */
  private apply(domain: string, service: string, entityId: string, data: Record<string, unknown>): void {
    const current = this.entities.get(entityId)
    if (!current) {
      this.bus.log('home-assistant', 'note', `no such entity ${entityId}`)
      return
    }

    if (domain === 'timer') {
      this.applyTimer(service, entityId, data)
      return
    }
    if (service === 'shuffle_set') {
      this.put(entityId, current.state, { shuffle: Boolean(data.shuffle) })
      return
    }
    if (service === 'play_media') {
      this.put(entityId, 'playing', { media_playlist: String(data.media_content_id ?? '') })
      return
    }
    if (service === 'media_next_track' || service === 'media_previous_track') {
      // Nothing to model here: there is no queue behind this fake.
      return
    }
    if (domain === 'light' && service === 'turn_on' && typeof data.brightness_step_pct === 'number') {
      const brightness = Number(current.attributes.brightness ?? 0)
      const stepped = Math.round(brightness + (data.brightness_step_pct / 100) * 255)
      const clamped = Math.max(0, Math.min(255, stepped))
      this.put(entityId, clamped === 0 ? 'off' : 'on', { brightness: clamped })
      return
    }
    if (domain === 'scene' && service === 'turn_on') {
      // Applying a scene is only visible through the light it sets.
      this.put('light.office', 'on', { brightness: 200 })
      return
    }

    const opened = domain === 'cover'
    const on = service === 'toggle' ? !isOn(current.state) : service === 'turn_on'
    this.put(entityId, on ? (opened ? 'open' : 'on') : (opened ? 'closed' : 'off'))
  }

  private applyTimer(service: string, entityId: string, data: Record<string, unknown>): void {
    if (service === 'cancel') {
      this.stopCountdown()
      const duration = String(this.entities.get(entityId)?.attributes.duration ?? '0:05:00')
      this.put(entityId, 'idle', { remaining: duration, finishes_at: undefined })
      return
    }
    if (service !== 'start') return

    const duration = String(data.duration ?? this.entities.get(entityId)?.attributes.duration ?? '0:05:00')
    const seconds = duration.split(':').map(Number).reduce((total, part) => total * 60 + (part || 0), 0)
    const finishesAt = new Date(Date.now() + seconds * 1000)
    this.put(entityId, 'active', { duration, remaining: duration, finishes_at: finishesAt.toISOString() })

    // Home Assistant does not tick either; it just says nothing until the timer
    // fires. This single timeout is what proves the tile is counting down from
    // `finishes_at` on its own rather than being repainted from events.
    this.stopCountdown()
    this.countdown = setTimeout(() => {
      this.put(entityId, 'idle', { remaining: duration, finishes_at: undefined })
      this.bus.log('home-assistant', 'in', `${entityId} finished`)
    }, seconds * 1000)
    this.countdown.unref()
  }

  private stopCountdown(): void {
    if (this.countdown) clearTimeout(this.countdown)
    this.countdown = null
  }
}

const isOn = (state: string): boolean => state === 'on' || state === 'open' || state === 'playing'
