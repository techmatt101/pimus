import type {HomeAssistantEntity} from '../types.mjs'

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
    readonly #entities = new Map<string, HomeAssistantEntity>()
    readonly #watchers = new Set<Watcher>()

    get(entityId: string): HomeAssistantEntity | undefined {
        return this.#entities.get(entityId)
    }

    // Only watched entities are kept, so a busy Home Assistant does not grow an
    // unbounded cache in a daemon that draws eight keys.
    watched(): ReadonlySet<string> {
        const ids = new Set<string>()
        for (const watcher of this.#watchers) for (const id of watcher.ids) ids.add(id)
        return ids
    }

    watch(entityIds: readonly string[], listener: () => void): () => void {
        const watcher: Watcher = {ids: new Set(entityIds), listener}
        this.#watchers.add(watcher)
        return () => {
            this.#watchers.delete(watcher)
        }
    }

    // An event carrying the state a tile already drew is dropped: Home Assistant
    // re-reports attributes freely, and a running timer would otherwise repaint
    // the deck on every unrelated update. Reports whether anything moved, so a
    // caller does not repaint for an update that changed nothing.
    set(entity: HomeAssistantEntity): boolean {
        const previous = this.#entities.get(entity.entity_id)
        if (previous && sameEntity(previous, entity)) return false
        this.#entities.set(entity.entity_id, entity)
        this.#notify(entity.entity_id)
        return true
    }

    replace(entities: readonly HomeAssistantEntity[]): void {
        this.#entities.clear()
        const watched = this.watched()
        for (const entity of entities) {
            if (watched.has(entity.entity_id)) this.#entities.set(entity.entity_id, entity)
        }
        this.#notifyAll()
    }

    remove(entityId: string): boolean {
        if (!this.#entities.delete(entityId)) return false
        this.#notify(entityId)
        return true
    }

    clear(): void {
        if (this.#entities.size === 0) return
        this.#entities.clear()
        this.#notifyAll()
    }

    #notify(entityId: string): void {
        // Copy first so a listener that unsubscribes mid-notification is safe.
        for (const watcher of [...this.#watchers]) if (watcher.ids.has(entityId)) watcher.listener()
    }

    #notifyAll(): void {
        for (const watcher of [...this.#watchers]) watcher.listener()
    }
}

/** Whether two reports of an entity would draw the same key face. */
function sameEntity(left: HomeAssistantEntity, right: HomeAssistantEntity): boolean {
    return left.state === right.state
        && JSON.stringify(left.attributes) === JSON.stringify(right.attributes)
}
