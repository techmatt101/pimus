import {numericAttribute} from '../home-assistant/entity.mjs'
import type {Action, AudioState, ControlState, HomeAssistantService, LvaSender,} from '../types.mjs'

export interface IndicatorContext {
    state: ControlState
    audio: AudioState
    source?: string | undefined
}

export interface KeyIndicator {
    isActive(context: IndicatorContext): boolean

    activeColor: string

    label?(configuredLabel: string, active: boolean): string
}

export interface ActionSpec {
    /** One line describing the effect; mirrored into docs/controls.md. */
    summary: string
    example: string
    indicator?: KeyIndicator
}

export interface VoiceContext {
    state: ControlState
    lva: LvaSender
    onStateChange: () => void
}

interface VoiceActionSpec extends ActionSpec {
    run(context: VoiceContext): void
}

export const ASSIST_ACTIVE = ['WAKE_WORD_DETECTED', 'LISTENING', 'THINKING', 'TTS_SPEAKING']

export const isAssistRunning = (state: ControlState): boolean => ASSIST_ACTIVE.includes(state.assist)

export const VOICE_ACTIONS = {
    start_listening: {
        summary: 'Start a voice pipeline, the same as speaking the wake word.',
        example: '{ type: lva, command: start_listening }',
        indicator: {
            isActive: ({state}) => isAssistRunning(state),
            activeColor: '#00b8d4',
        },
        run: ({lva}) => {
            lva.send('start_listening')
        },
    },
    listen_toggle: {
        summary: 'Start a voice pipeline, or cancel the one already running.',
        example: '{ type: lva, command: listen_toggle }',
        indicator: {
            isActive: ({state}) => isAssistRunning(state),
            activeColor: '#00b8d4',
            label: (configured, active) => (active ? 'CANCEL' : configured),
        },
        run: ({state, lva}) => {
            lva.send(isAssistRunning(state) ? 'stop_pipeline' : 'start_listening')
        },
    },
    mute_toggle: {
        summary: 'Toggle the microphone mute. Tracks the mute state reported by LVA.',
        example: '{ type: lva, command: mute_toggle }',
        indicator: {
            isActive: ({state}) => state.muted,
            activeColor: '#d50000',
            label: (configured, active) => (active ? 'MIC OFF' : configured),
        },
        run: ({state, lva}) => {
            // LVA has no toggle command; the resulting `muted` event is what
            // updates our state.
            lva.send(state.muted ? 'unmute_mic' : 'mute_mic')
        },
    },
    media_toggle: {
        summary: 'Play or pause the media player.',
        example: '{ type: lva, command: media_toggle }',
        indicator: {
            isActive: ({state}) => state.media,
            activeColor: '#00c853',
            label: (configured, active) => (active ? 'PAUSE' : configured),
        },
        run: ({state, lva, onStateChange}) => {
            lva.send(state.media ? 'pause_media_player' : 'resume_media_player')
            // Optimistic repaint; LVA's media_player_* event reconciles any disagreement.
            state.media = !state.media
            onStateChange()
        },
    },
    stop: {
        summary: 'Stop everything at once: timer ringing, the pipeline, and media playback.',
        example: '{ type: lva, command: stop }',
        run: ({state, lva, onStateChange}) => {
            lva.send('stop_timer_ringing')
            lva.send('stop_pipeline')
            lva.send('stop_media_player')
            state.media = false
            onStateChange()
        },
    },
    stop_timer_ringing: {
        summary: 'Silence a ringing timer, leaving media playback alone.',
        example: '{ type: lva, command: stop_timer_ringing }',
        run: ({lva}) => {
            lva.send('stop_timer_ringing')
        },
    },
} as const satisfies Record<string, VoiceActionSpec>

export type VoiceActionName = keyof typeof VOICE_ACTIONS

export const VOLUME_ACTIONS = {
    up: {
        summary: 'Raise the default sink by 5%, capped at 100%.',
        example: '{ type: audio, command: up }',
    },
    down: {
        summary: 'Lower the default sink by 5%.',
        example: '{ type: audio, command: down }',
    },
    mute: {
        summary: 'Toggle mute on the default sink.',
        example: '{ type: audio, command: mute }',
    },
} as const satisfies Record<string, ActionSpec>

export type VolumeActionName = keyof typeof VOLUME_ACTIONS

const routeIndicator: KeyIndicator = {
    isActive: ({audio, source}) => Boolean(source && audio.sources[source]),
    activeColor: '#1b5e20',
    label: (configured, active) => `${configured} ${active ? 'ON' : 'OFF'}`,
}

export const ROUTE_ACTIONS = {
    on: {
        summary: 'Enable the named audio route.',
        example: '{ type: audio, source: aux, command: "on" }',
        indicator: routeIndicator,
    },
    off: {
        summary: 'Disable the named audio route.',
        example: '{ type: audio, source: aux, command: "off" }',
        indicator: routeIndicator,
    },
    toggle: {
        summary: 'Flip the named audio route on or off.',
        example: '{ type: audio, source: aux, command: toggle }',
        indicator: routeIndicator,
    },
} as const satisfies Record<string, ActionSpec>

export type RouteActionName = keyof typeof ROUTE_ACTIONS

export interface HaContext {
    ha: HomeAssistantService
    entity: string
    data?: Record<string, unknown> | undefined
}

interface HaActionSpec extends ActionSpec {
    run(context: HaContext): void
}

/**
 * An entity id's domain is also the domain of the service that acts on it:
 * `fan.office_ceiling` is turned off by `fan.turn_off`.
 */
export const entityDomain = (entityId: string): string => entityId.split('.')[0] ?? ''

export const ENTITY_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/

export function requireEntity(entityId: string, where: string): string {
    if (!ENTITY_ID.test(entityId)) {
        throw new Error(`${where}: "${entityId}" is not a Home Assistant entity id such as "fan.office_ceiling"`)
    }
    return entityId
}

const BRIGHTNESS_STEP_PERCENT = 10

const COVER_STEP_PERCENT = 10

// Home Assistant has no relative service for a cover the way `brightness_step_pct`
// is for a light, so the step is applied to the position the cover reports. A
// cover reporting no position gets the plain full open or close instead.
function stepCover({ha, entity}: HaContext, step: number): void {
    const position = numericAttribute(ha.entity(entity), 'current_position')
    if (position === undefined) {
        ha.call('cover', step > 0 ? 'open_cover' : 'close_cover', entity)
        return
    }
    ha.call('cover', 'set_cover_position', entity, {
        position: Math.max(0, Math.min(100, Math.round(position + step))),
    })
}

export const HA_ACTIONS = {
    toggle: {
        summary: 'Flip an entity on or off: a light, fan, switch, cover, or helper.',
        example: "ha('toggle', 'fan.office_ceiling')",
        run: ({ha, entity}) => ha.call(entityDomain(entity), 'toggle', entity),
    },
    turn_on: {
        summary: 'Turn an entity on. A cover opens.',
        example: "ha('turn_on', 'switch.office_pc')",
        run: ({ha, entity, data}) => ha.call(entityDomain(entity), 'turn_on', entity, data),
    },
    turn_off: {
        summary: 'Turn an entity off. A cover closes.',
        example: "ha('turn_off', 'switch.office_pc')",
        run: ({ha, entity, data}) => ha.call(entityDomain(entity), 'turn_off', entity, data),
    },
    activate: {
        summary: 'Activate a scene or run a script, which have no matching "off".',
        example: "ha('activate', 'scene.office_bright')",
        run: ({ha, entity, data}) => ha.call(entityDomain(entity), 'turn_on', entity, data),
    },
    play_media: {
        summary: 'Play a media id on a media player, such as a saved playlist.',
        example: "ha('play_media', 'media_player.office', { media_content_id: '...', media_content_type: 'playlist' })",
        run: ({ha, entity, data}) => ha.call('media_player', 'play_media', entity, data),
    },
    media_next: {
        summary: 'Skip a media player to the next track.',
        example: "ha('media_next', 'media_player.office')",
        run: ({ha, entity}) => ha.call('media_player', 'media_next_track', entity),
    },
    media_previous: {
        summary: 'Send a media player back to the previous track.',
        example: "ha('media_previous', 'media_player.office')",
        run: ({ha, entity}) => ha.call('media_player', 'media_previous_track', entity),
    },
    media_shuffle: {
        summary: 'Toggle shuffle on a media player, from the shuffle state it reports.',
        example: "ha('media_shuffle', 'media_player.office')",
        run: ({ha, entity}) => {
            // shuffle_set only takes an absolute value; an unknown player is
            // assumed un-shuffled.
            ha.call('media_player', 'shuffle_set', entity, {shuffle: !isShuffled(ha, entity)})
        },
    },
    brightness_up: {
        summary: `Raise a light's brightness by ${BRIGHTNESS_STEP_PERCENT}%.`,
        example: "ha('brightness_up', 'light.office')",
        run: ({ha, entity}) => {
            ha.call('light', 'turn_on', entity, {brightness_step_pct: BRIGHTNESS_STEP_PERCENT})
        },
    },
    brightness_down: {
        summary: `Lower a light's brightness by ${BRIGHTNESS_STEP_PERCENT}%.`,
        example: "ha('brightness_down', 'light.office')",
        run: ({ha, entity}) => {
            ha.call('light', 'turn_on', entity, {brightness_step_pct: -BRIGHTNESS_STEP_PERCENT})
        },
    },
    fan_speed_up: {
        summary: "Raise a fan's speed by one of its own steps.",
        example: "ha('fan_speed_up', 'fan.office_ceiling')",
        // The fan's own step count, not percentage_step: a three-speed ceiling fan
        // should not need four turns to reach medium.
        run: ({ha, entity}) => ha.call('fan', 'increase_speed', entity),
    },
    fan_speed_down: {
        summary: "Lower a fan's speed by one of its own steps.",
        example: "ha('fan_speed_down', 'fan.office_ceiling')",
        run: ({ha, entity}) => ha.call('fan', 'decrease_speed', entity),
    },
    cover_open: {
        summary: `Open a cover by ${COVER_STEP_PERCENT}%, or fully when it reports no position.`,
        example: "ha('cover_open', 'cover.office_blinds')",
        run: (context) => stepCover(context, COVER_STEP_PERCENT),
    },
    cover_close: {
        summary: `Close a cover by ${COVER_STEP_PERCENT}%, or fully when it reports no position.`,
        example: "ha('cover_close', 'cover.office_blinds')",
        run: (context) => stepCover(context, -COVER_STEP_PERCENT),
    },
    timer_toggle: {
        summary: 'Start a Home Assistant timer, or cancel the one already running.',
        example: "ha('timer_toggle', 'timer.office', { duration: '00:05:00' })",
        run: ({ha, entity, data}) => {
            // `timer.start` on a running timer restarts it, so cancel instead.
            const running = ha.entity(entity)?.state
            if (running === 'active' || running === 'paused') ha.call('timer', 'cancel', entity)
            else ha.call('timer', 'start', entity, data)
        },
    },
} as const satisfies Record<string, HaActionSpec>

export type HaActionName = keyof typeof HA_ACTIONS

export function isShuffled(ha: HomeAssistantService, entityId: string): boolean {
    return Boolean(ha.entity(entityId)?.attributes.shuffle)
}

const has = <T extends object>(table: T, key: string): key is Extract<keyof T, string> =>
    Object.hasOwn(table, key)

export const isVoiceAction = (command: string): command is VoiceActionName =>
    has(VOICE_ACTIONS, command)

export const isVolumeAction = (command: string): command is VolumeActionName =>
    has(VOLUME_ACTIONS, command)

export const isRouteAction = (command: string): command is RouteActionName =>
    has(ROUTE_ACTIONS, command)

export const isHaAction = (command: string): command is HaActionName => has(HA_ACTIONS, command)

export function runHaCommand(command: HaActionName, context: HaContext): void {
    HA_ACTIONS[command].run(context)
}

/** An uncatalogued command is forwarded to LVA verbatim. */
export function runVoiceCommand(command: string, context: VoiceContext): void {
    if (isVoiceAction(command)) VOICE_ACTIONS[command].run(context)
    else context.lva.send(command)
}

export function indicatorFor(action: Action | undefined): KeyIndicator | undefined {
    if (!action?.command) return undefined
    if (action.type === 'lva' && isVoiceAction(action.command)) {
        // `satisfies` kept the literal entry types; widen to read the optional field.
        return (VOICE_ACTIONS[action.command] as ActionSpec).indicator
    }
    if (action.type === 'audio') {
        if (action.source) {
            return isRouteAction(action.command) ? ROUTE_ACTIONS[action.command].indicator : undefined
        }
        return undefined
    }
    return undefined
}

export function describeActionProblem(action: unknown): string | null {
    if (action === undefined) return null
    if (typeof action !== 'object' || action === null || Array.isArray(action)) {
        return 'an action must be an object'
    }
    const {type, command, source} = action as Record<string, unknown>

    if (type === 'noop' || type === undefined) return null

    if (type === 'lva') {
        return typeof command === 'string' && command.length > 0
            ? null
            : 'an "lva" action needs a command'
    }

    if (type === 'audio') {
        if (typeof command !== 'string' || command.length === 0) {
            return 'an "audio" action needs a command'
        }
        if (source === undefined) {
            return isVolumeAction(command)
                ? null
                : `unknown volume command "${command}"; expected ${Object.keys(VOLUME_ACTIONS).join(', ')}`
        }
        if (typeof source !== 'string' || source.length === 0) {
            return 'an "audio" action source must be a non-empty route name'
        }
        return isRouteAction(command)
            ? null
            : `unknown route command "${command}"; expected ${Object.keys(ROUTE_ACTIONS).join(', ')}`
    }

    if (type === 'ha') {
        const {entity} = action as Record<string, unknown>
        if (typeof command !== 'string' || !isHaAction(command)) {
            return `unknown Home Assistant command "${String(command)}"; expected ${Object.keys(HA_ACTIONS).join(', ')}`
        }
        return typeof entity === 'string' && ENTITY_ID.test(entity)
            ? null
            : 'a "ha" action needs an entity id such as "fan.office_ceiling"'
    }

    return `unknown action type "${String(type)}"; expected noop, lva, audio, or ha`
}
