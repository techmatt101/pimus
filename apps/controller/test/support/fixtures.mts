// Shared test doubles for the injected controller boundaries. Tiles and dial
// bindings depend on the narrow interfaces in src/types.mts, so a test needs no
// Stream Deck, no Home Assistant, and no audio manager — only these recording
// objects.
//
// This is the one folder under test/ that does not mirror a src module: it
// holds fixtures rather than tests, and every tile test would otherwise carry
// its own slightly different copy of them.

import { NotificationCenter } from '../../src/home-assistant/notifications.mjs'
import { ControlModel, createState } from '../../src/state.mjs'
import type { TileServices } from '../../src/streamdeck/bindings.mjs'
import {
  STRIP_HEIGHT,
  STRIP_WIDTH,
  type Screen,
  type ScreenContext,
  type ScreenHost,
} from '../../src/streamdeck/screens/screen.mjs'
import { TouchStrip } from '../../src/streamdeck/strip.mjs'
import { Surface } from '../../src/streamdeck/surface.mjs'
import type { Dial } from '../../src/streamdeck/dials/dial.mjs'
import { KEY_SIZE, type Tile, type TileContext, type TileHost } from '../../src/streamdeck/tiles/tile.mjs'
import type {
  AudioState,
  ControlState,
  HomeAssistantEntity,
  HomeAssistantService,
  NotificationFeed,
} from '../../src/types.mjs'

/** A recording Home Assistant with a state cache the test writes directly. */
export class FakeHomeAssistant implements HomeAssistantService {
  connected = true
  /** Every service call made, as `domain.service entity {json}`. */
  readonly calls: string[] = []
  private readonly entities = new Map<string, HomeAssistantEntity>()
  private readonly watchers: Array<{ ids: ReadonlySet<string>; listener: () => void }> = []
  private readonly listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>()

  constructor(entities: Record<string, { state: string; attributes?: Record<string, unknown> }> = {}) {
    for (const [entityId, entity] of Object.entries(entities)) this.put(entityId, entity.state, entity.attributes)
  }

  /** Set an entity's state and report it to whoever is watching. */
  put(entityId: string, state: string, attributes: Record<string, unknown> = {}): void {
    this.entities.set(entityId, { entity_id: entityId, state, attributes })
    for (const watcher of [...this.watchers]) if (watcher.ids.has(entityId)) watcher.listener()
  }

  /** Forget everything, as losing the connection does. */
  drop(): void {
    this.connected = false
    this.entities.clear()
    for (const watcher of [...this.watchers]) watcher.listener()
  }

  entity(entityId: string): HomeAssistantEntity | undefined {
    return this.entities.get(entityId)
  }

  call(domain: string, service: string, entityId: string, data?: Record<string, unknown>): void {
    this.calls.push(`${domain}.${service} ${entityId}${data ? ` ${JSON.stringify(data)}` : ''}`)
  }

  watch(entityIds: readonly string[], listener: () => void): () => void {
    const watcher = { ids: new Set(entityIds), listener }
    this.watchers.push(watcher)
    return () => {
      const index = this.watchers.indexOf(watcher)
      if (index >= 0) this.watchers.splice(index, 1)
    }
  }

  listen(eventType: string, listener: (data: Record<string, unknown>) => void): () => void {
    const listeners = this.listeners.get(eventType) ?? new Set()
    listeners.add(listener)
    this.listeners.set(eventType, listeners)
    return () => {
      listeners.delete(listener)
    }
  }

  /** Fire an event, as a Home Assistant automation does. */
  fire(eventType: string, data: Record<string, unknown>): void {
    for (const listener of [...(this.listeners.get(eventType) ?? [])]) listener(data)
  }

  /** How many watches are open, so a test can prove unmount dropped them. */
  get watchCount(): number {
    return this.watchers.length
  }
}

export interface TestServices extends TileServices {
  model: ControlModel
  ha: FakeHomeAssistant
  /** Live over the fake Home Assistant, so `ha.fire(NOTIFY_EVENT, …)` reaches the strip. */
  notifications: NotificationCenter
  /** Every call made through the injected services, in order. */
  calls: string[]
}

/**
 * The injected services, recording everything they are asked to do. `calls`
 * collects the LVA, audio route, and volume traffic; Home Assistant calls are
 * on `ha.calls` so a test can assert one without the other.
 */
export function testServices(
  state: ControlState = createState(),
  audio: () => AudioState = () => ({ sources: {} }),
  entities: Record<string, { state: string; attributes?: Record<string, unknown> }> = {},
): TestServices {
  const calls: string[] = []
  const ha = new FakeHomeAssistant(entities)
  const notifications = new NotificationCenter({ ha, logger: { log: () => {} } })
  notifications.start()
  return {
    calls,
    model: new ControlModel(state, audio),
    ha,
    notifications,
    lva: { send: (command) => { calls.push(`lva:${command}`) } },
    setSource: (name, command) => calls.push(`source:${name}:${command}`),
    setVolume: (command) => calls.push(`volume:${command}`),
  }
}

/** A strip screen that draws nothing, for a test that only cares about selection. */
export class BlankScreen implements Screen {
  draw(surface: Surface): void {
    surface.fill('#000000')
  }
}

/** A painted face: its pixels, and the size it was painted at. */
export interface Face {
  width: number
  height: number
  buffer: Buffer
}

/**
 * The face a tile paints for a context. Faces are compared whole rather than
 * inspected: a test asserts that two states look different, or that one is
 * stable, without depending on where anything within the key is drawn.
 */
export function tileFace(tile: Tile, context: TileContext = testContext()): Face {
  return paint(new Surface(KEY_SIZE, KEY_SIZE), (surface) => tile.draw(surface, context))
}

/** The face a screen paints, the strip's equivalent of tileFace(). */
export function screenFace(screen: Screen, context: ScreenContext): Face {
  return paint(new Surface(STRIP_WIDTH, STRIP_HEIGHT), (surface) => screen.draw(surface, context))
}

/** The face the strip paints, which is whichever screen it selected. */
export function stripFace(strip: TouchStrip, context: TileContext): Face {
  return paint(new Surface(STRIP_WIDTH, STRIP_HEIGHT), (surface) => strip.draw(surface, context))
}

function paint(surface: Surface, draw: (surface: Surface) => void): Face {
  surface.reset()
  draw(surface)
  return { width: surface.width, height: surface.height, buffer: surface.snapshot() }
}

/**
 * A touch strip over `dials` with a blank resting face, so a test can build a
 * layout without caring what the strip rests on.
 */
export function testStrip(
  dials: readonly Dial[] = [],
  notifications?: NotificationFeed,
): TouchStrip {
  return new TouchStrip({ resting: new BlankScreen(), dials, ...(notifications ? { notifications } : {}) })
}

/** A strip host that counts repaints, the strip's equivalent of testHost(). */
export function testScreenHost(): ScreenHost & { repaints: number } {
  const host = { repaints: 0, invalidate: () => { host.repaints += 1 } }
  return host
}

/** A tile host that counts repaints and records page moves. */
export function testHost(): TileHost & { repaints: number; moves: number[]; name: string } {
  const host = {
    repaints: 0,
    moves: [] as number[],
    name: 'NEXT',
    invalidate: () => { host.repaints += 1 },
    changePage: (delta: number) => { host.moves.push(delta) },
    pageName: () => host.name,
  }
  return host
}

export const testContext = (
  state: ControlState = createState(),
  { sources = {}, now = 0 }: { sources?: Record<string, boolean>; now?: number } = {},
): TileContext => ({ state, audio: { sources }, now })

/** Resolves once `predicate` holds; the enclosing test times out on failure. */
export const eventually = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 2))
}
