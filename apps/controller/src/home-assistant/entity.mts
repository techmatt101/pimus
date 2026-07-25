import type {HomeAssistantEntity} from '../types.mjs'

const ON_STATES = new Set(['on', 'open', 'opening', 'playing', 'active', 'home', 'heat', 'cool'])
const OFF_STATES = new Set(['off', 'closed', 'closing', 'idle', 'paused', 'standby', 'not_home'])

/**
 * Whether an entity reads as on, or undefined when it is unknown. Tiles draw
 * that third case rather than guessing "off", so a broken connection never
 * looks like a fan that is simply switched off.
 */
export function isEntityOn(entity: HomeAssistantEntity | undefined): boolean | undefined {
    if (!entity) return undefined
    if (ON_STATES.has(entity.state)) return true
    if (OFF_STATES.has(entity.state)) return false
    return undefined
}

export function numericState(entity: HomeAssistantEntity | undefined): number | undefined {
    if (!entity) return undefined
    const value = Number(entity.state)
    return Number.isFinite(value) ? value : undefined
}

export function numericAttribute(
    entity: HomeAssistantEntity | undefined,
    name: string,
): number | undefined {
    const value = Number(entity?.attributes[name])
    return Number.isFinite(value) ? value : undefined
}

// Timers report `H:MM:SS` strings, and some integrations report plain seconds.
export function durationSeconds(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'string') return undefined
    const parts = value.split(':').map(Number)
    if (parts.length === 0 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
        return undefined
    }
    return parts.reduce((total, part) => total * 60 + part, 0)
}

/** `HH:MM:SS`, the shape Home Assistant's `timer.start` wants a duration in. */
export function secondsToHms(seconds: number): string {
    const whole = Math.max(0, Math.round(seconds))
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    const secs = whole % 60
    return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')
}

// A running timer only re-reports `remaining` when paused or reset, so the
// countdown comes from `finishes_at`; the `remaining` fallback is what makes a
// paused timer hold its reading.
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

// A media player reports `media_position` once, with the instant it was
// measured, so a moving progress bar is derived from that against `now`.
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

/** `M:SS`, or `H:MM` once an hour or more is left. */
export function formatDuration(seconds: number): string {
    const whole = Math.max(0, Math.ceil(seconds))
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}`
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}
