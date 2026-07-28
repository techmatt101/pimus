import type {HomeAssistantEntity} from '../types.mjs'

// The shape `subscribe_entities` answers in: `s` is the state, `a` the
// attributes, and a change carries only what moved — `+` what was added or
// overwritten, `-` the attribute names that went away.
type Attributes = Record<string, unknown>

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function attributesOf(value: unknown): Attributes {
    return isObject(value) ? {...value} : {}
}

/** The `a` block: the entities of a fresh subscription, each fully specified. */
export function decodeAdded(payload: unknown): HomeAssistantEntity[] {
    if (!isObject(payload)) return []
    const entities: HomeAssistantEntity[] = []
    for (const [entityId, compressed] of Object.entries(payload)) {
        if (!isObject(compressed) || typeof compressed.s !== 'string') continue
        entities.push({entity_id: entityId, state: compressed.s, attributes: attributesOf(compressed.a)})
    }
    return entities
}

/** The `c` block, merged onto what is already cached. */
export function decodeChanged(
    payload: unknown,
    read: (entityId: string) => HomeAssistantEntity | undefined,
): HomeAssistantEntity[] {
    if (!isObject(payload)) return []
    const entities: HomeAssistantEntity[] = []
    for (const [entityId, diff] of Object.entries(payload)) {
        if (!isObject(diff)) continue
        const current = read(entityId)
        const added = isObject(diff['+']) ? diff['+'] : {}
        const state = typeof added.s === 'string' ? added.s : current?.state
        if (state === undefined) continue
        const attributes = {...(current?.attributes ?? {}), ...attributesOf(added.a)}
        const dropped = isObject(diff['-']) ? diff['-'].a : undefined
        if (Array.isArray(dropped)) for (const name of dropped) delete attributes[String(name)]
        entities.push({entity_id: entityId, state, attributes})
    }
    return entities
}

/** The `r` block: entities that no longer exist. */
export function decodeRemoved(payload: unknown): string[] {
    return Array.isArray(payload) ? payload.filter((id): id is string => typeof id === 'string') : []
}
