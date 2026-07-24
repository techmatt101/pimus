// Reading meaning out of a Home Assistant entity. Home Assistant reports state
// as strings and attributes as loose JSON, so the interpretation every tile
// needs — is this on, what does this sensor read, how long is left on this
// timer — lives here rather than being re-derived on each key face.

import type {HomeAssistantEntity} from '../types.mjs'

/** States that mean "on" across the domains the control surface drives. */
const ON_STATES = new Set(['on', 'open', 'opening', 'playing', 'active', 'home', 'heat', 'cool'])
const OFF_STATES = new Set(['off', 'closed', 'closing', 'idle', 'paused', 'standby', 'not_home'])

/**
 * Whether an entity reads as on, or undefined when it is unknown — either
 * because Home Assistant is unreachable, the entity does not exist, or it
 * genuinely reports `unknown`/`unavailable`. Tiles draw that third case rather
 * than guessing "off", so a broken connection never looks like a fan that is
 * simply switched off.
 */
export function isEntityOn(entity: HomeAssistantEntity | undefined): boolean | undefined {
    if (!entity) return undefined
    if (ON_STATES.has(entity.state)) return true
    if (OFF_STATES.has(entity.state)) return false
    return undefined
}

/** A sensor's numeric reading, or undefined when it is not a number. */
export function numericState(entity: HomeAssistantEntity | undefined): number | undefined {
    if (!entity) return undefined
    const value = Number(entity.state)
    return Number.isFinite(value) ? value : undefined
}

/** A numeric attribute, for things like `temperature` on a weather entity. */
export function numericAttribute(
    entity: HomeAssistantEntity | undefined,
    name: string,
): number | undefined {
    const value = Number(entity?.attributes[name])
    return Number.isFinite(value) ? value : undefined
}

/**
 * Seconds in a Home Assistant duration. Timers report `H:MM:SS` strings, and
 * some integrations report plain seconds, so accept both.
 */
export function durationSeconds(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'string') return undefined
    const parts = value.split(':').map(Number)
    if (parts.length === 0 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
        return undefined
    }
    return parts.reduce((total, part) => total * 60 + part, 0)
}

/**
 * Seconds left on a `timer` entity at instant `now`.
 *
 * A running timer only re-reports `remaining` when it is paused or reset, so a
 * countdown has to come from `finishes_at`; falling back to `remaining` is what
 * makes a paused timer hold its reading instead of counting to zero.
 */
export function timerRemainingSeconds(
    entity: HomeAssistantEntity | undefined,
    now: number,
): number | undefined {
    if (!entity) return undefined
    if (entity.state === 'active') {
        const finishesAt = entity.attributes.finishes_at
        if (typeof finishesAt === 'string') {
            const end = Date.parse(finishesAt)
            if (Number.isFinite(end)) return Math.max(0, (end - now) / 1000)
        }
    }
    return durationSeconds(entity.attributes.remaining) ?? durationSeconds(entity.attributes.duration)
}

/**
 * Seconds into the current track at `now`, or undefined when the player does
 * not report a position. A media player reports `media_position` once, with the
 * instant it was measured, so a progress bar that moves has to be derived the
 * same way a running timer's countdown is. A player that is not playing holds
 * the position it reported.
 */
export function mediaElapsedSeconds(
    entity: HomeAssistantEntity | undefined,
    now: number,
): number | undefined {
    const position = numericAttribute(entity, 'media_position')
    if (position === undefined || entity?.state !== 'playing') return position
    const measuredAt = entity.attributes.media_position_updated_at
    const measured = typeof measuredAt === 'string' ? Date.parse(measuredAt) : Number.NaN
    if (!Number.isFinite(measured)) return position
    return position + Math.max(0, (now - measured) / 1000)
}

/** A countdown as `M:SS`, or `H:MM` once an hour or more is left. */
export function formatDuration(seconds: number): string {
    const whole = Math.max(0, Math.ceil(seconds))
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}`
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}
