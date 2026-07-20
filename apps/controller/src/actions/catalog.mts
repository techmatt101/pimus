// The catalog of everything a Stream Deck key or dial can be bound to.
//
// This file is the single source of truth for the control surface. Adding an
// action here is what makes it configurable, dispatchable, validated at
// startup, and reflected on the key face:
//
//   - actions/handler.mts must supply a runner for every voice action, so a new
//     catalog entry fails to compile until its behaviour exists.
//   - config.mts rejects an unknown action when controller.json loads, instead
//     of leaving a silently dead key on the deck.
//   - streamdeck/renderer.mts reads the `indicator` below to decide the active
//     colour and label, so key feedback lives with the action it belongs to.
//
// Bindings themselves live in streamdeck/layout.mts; docs/controls.md is the
// reference table. When you add an action, update all three together.

import type { Action, AudioState, ControlState } from '../types.mjs'

/** State an indicator may consult to decide whether its key reads as active. */
export interface IndicatorContext {
  state: ControlState
  audio: AudioState
  /** The bound action's `source`, for audio-route actions. */
  source?: string | undefined
}

/** How a key face reports that its action's target is currently active. */
export interface KeyIndicator {
  isActive(context: IndicatorContext): boolean
  /** Background colour drawn while active, replacing the configured colour. */
  activeColor: string
  /** Label override. Receives the configured label and the active flag. */
  label?(configuredLabel: string, active: boolean): string
}

export interface ActionSpec {
  /** One line describing the effect; mirrored into docs/controls.md. */
  summary: string
  /** A copy-pasteable inventory fragment for this action. */
  example: string
  indicator?: KeyIndicator
}

const ASSIST_ACTIVE = ['WAKE_WORD_DETECTED', 'LISTENING', 'THINKING', 'TTS_SPEAKING']

/**
 * Voice actions (`type: lva`) sent to the Linux Voice Assistant peripheral
 * socket. Every entry needs a runner in actions/handler.mts.
 *
 * LVA accepts more commands than these. Any command not listed is forwarded
 * verbatim (see FORWARDED_VOICE_COMMAND below), so upstream additions work
 * without a controller change; list one here when it needs local state
 * bookkeeping, key feedback, or expands to several LVA commands.
 */
export const VOICE_ACTIONS = {
  start_listening: {
    summary: 'Start a voice pipeline, the same as speaking the wake word.',
    example: '{ type: lva, command: start_listening }',
    indicator: {
      isActive: ({ state }) => ASSIST_ACTIVE.includes(state.assist),
      activeColor: '#00b8d4',
    },
  },
  mute_toggle: {
    summary: 'Toggle the microphone mute. Tracks the mute state reported by LVA.',
    example: '{ type: lva, command: mute_toggle }',
    indicator: {
      isActive: ({ state }) => state.muted,
      activeColor: '#d50000',
      label: (configured, active) => (active ? 'MIC OFF' : configured),
    },
  },
  media_toggle: {
    summary: 'Play or pause the media player.',
    example: '{ type: lva, command: media_toggle }',
    indicator: {
      isActive: ({ state }) => state.media,
      activeColor: '#00c853',
      label: (configured, active) => (active ? 'PAUSE' : configured),
    },
  },
  stop: {
    summary: 'Stop everything at once: timer ringing, the pipeline, and media playback.',
    example: '{ type: lva, command: stop }',
  },
  stop_timer_ringing: {
    summary: 'Silence a ringing timer, leaving media playback alone.',
    example: '{ type: lva, command: stop_timer_ringing }',
  },
} as const satisfies Record<string, ActionSpec>

export type VoiceActionName = keyof typeof VOICE_ACTIONS

/** Documents the escape hatch for LVA commands with no catalog entry. */
export const FORWARDED_VOICE_COMMAND: ActionSpec = {
  summary: 'Any other command is forwarded to LVA unchanged, with no local state or key feedback.',
  example: '{ type: lva, command: <any LVA command> }',
}

/**
 * Master volume actions (`type: audio` with no `source`). These drive the
 * PipeWire default sink through wpctl; see audio/volume.mts.
 */
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
  isActive: ({ audio, source }) => Boolean(source && audio.sources[source]),
  activeColor: '#1b5e20',
  label: (configured, active) => `${configured} ${active ? 'ON' : 'OFF'}`,
}

/**
 * Audio route actions (`type: audio` with a `source`). The source name must be
 * a route the audio manager owns, such as `aux` or `usb`; the manager is
 * authoritative and rejects names it does not know.
 */
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

export const WEBHOOK_ACTION: ActionSpec = {
  summary: 'POST to <home_assistant_webhook_base>/<id>. Does nothing if no base URL is configured.',
  example: '{ type: webhook, id: office_lights }',
}

export const NOOP_ACTION: ActionSpec = {
  summary: 'Do nothing. Use it to blank a dial direction you do not want bound.',
  example: '{ type: noop }',
}

const has = <T extends object>(table: T, key: string): key is Extract<keyof T, string> =>
  Object.hasOwn(table, key)

export const isVoiceAction = (command: string): command is VoiceActionName =>
  has(VOICE_ACTIONS, command)

export const isVolumeAction = (command: string): command is VolumeActionName =>
  has(VOLUME_ACTIONS, command)

export const isRouteAction = (command: string): command is RouteActionName =>
  has(ROUTE_ACTIONS, command)

/** The key indicator for a bound action, if it reports an active state. */
export function indicatorFor(action: Action | undefined): KeyIndicator | undefined {
  if (!action?.command) return undefined
  if (action.type === 'lva' && isVoiceAction(action.command)) {
    // `satisfies` keeps the literal types, so only entries that declare an
    // indicator expose one; read it off the shared spec shape.
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

/**
 * Explains why a configured action is unusable, or null when it is valid.
 * config.mts calls this so a typo fails at startup with a readable message
 * rather than producing a key that silently does nothing when pressed.
 */
export function describeActionProblem(action: unknown): string | null {
  if (action === undefined) return null
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return 'an action must be an object'
  }
  const { type, command, source, id } = action as Record<string, unknown>

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

  if (type === 'webhook') {
    return typeof id === 'string' && id.length > 0 ? null : 'a "webhook" action needs an id'
  }

  return `unknown action type "${String(type)}"; expected noop, lva, audio, or webhook`
}
