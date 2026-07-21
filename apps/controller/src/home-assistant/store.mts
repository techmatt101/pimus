// The controller's view of Home Assistant entity state: a cache of the entities
// something on the control surface is watching, plus the change notification
// tiles subscribe to. Keeping this separate from the socket (client.mts) means
// the caching and notification rules are testable without a WebSocket, and the
// client stays about the protocol.

import type { HomeAssistantEntity } from '../types.mjs'

interface Watcher {
  ids: ReadonlySet<string>
  listener: () => void
}

/**
 * A last-known-state cache keyed by entity id. Nothing here polls or fetches:
 * the client feeds it a full snapshot after authenticating and one entity per
 * `state_changed` event afterwards.
 */
export class EntityStore {
  private readonly entities = new Map<string, HomeAssistantEntity>()
  private readonly watchers = new Set<Watcher>()

  get(entityId: string): HomeAssistantEntity | undefined {
    return this.entities.get(entityId)
  }

  /**
   * Every entity id currently watched. The client subscribes to all state
   * changes but only needs to *keep* these, so a busy Home Assistant does not
   * grow an unbounded cache in a daemon that draws eight keys.
   */
  watched(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const watcher of this.watchers) for (const id of watcher.ids) ids.add(id)
    return ids
  }

  watch(entityIds: readonly string[], listener: () => void): () => void {
    const watcher: Watcher = { ids: new Set(entityIds), listener }
    this.watchers.add(watcher)
    return () => {
      this.watchers.delete(watcher)
    }
  }

  /**
   * Store one entity, reporting to the watchers that care. An event carrying
   * the state a tile already drew is dropped rather than repainted: Home
   * Assistant re-reports attributes freely, and an entity such as a running
   * timer would otherwise repaint the deck on every unrelated update.
   */
  set(entity: HomeAssistantEntity): void {
    const previous = this.entities.get(entity.entity_id)
    if (previous && sameEntity(previous, entity)) return
    this.entities.set(entity.entity_id, entity)
    this.notify(entity.entity_id)
  }

  /** Replace the cache from a full snapshot, keeping only watched entities. */
  replace(entities: readonly HomeAssistantEntity[]): void {
    this.entities.clear()
    const watched = this.watched()
    for (const entity of entities) {
      if (watched.has(entity.entity_id)) this.entities.set(entity.entity_id, entity)
    }
    this.notifyAll()
  }

  /**
   * Forget everything, on losing the connection. Tiles then draw unknown state
   * rather than a stale reading that looks live.
   */
  clear(): void {
    if (this.entities.size === 0) return
    this.entities.clear()
    this.notifyAll()
  }

  private notify(entityId: string): void {
    // Copy first so a listener that unsubscribes mid-notification is safe.
    for (const watcher of [...this.watchers]) if (watcher.ids.has(entityId)) watcher.listener()
  }

  private notifyAll(): void {
    for (const watcher of [...this.watchers]) watcher.listener()
  }
}

/** Whether two reports of an entity would draw the same key face. */
function sameEntity(left: HomeAssistantEntity, right: HomeAssistantEntity): boolean {
  return left.state === right.state
    && JSON.stringify(left.attributes) === JSON.stringify(right.attributes)
}
