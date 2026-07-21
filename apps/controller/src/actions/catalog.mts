// The catalog of everything a Stream Deck key or dial can be bound to.
//
// This file is the single source of truth for the control surface. Adding an
// action here is what makes it bindable, validated, and reflected on the key
// face:
//
//   - every voice action declares its `run` behaviour in its own entry, so a
//     new catalog entry fails to compile until its behaviour exists.
//   - layout.test.mts rejects a bound action the catalog does not understand,
//     instead of leaving a silently dead key on the deck.
//   - streamdeck/tile.mts reads the `indicator` below to decide the active
//     colour and label, so key feedback lives with the action it belongs to.
//
// Bindings themselves are built in streamdeck/layout.mts from the injected
// controller services; docs/controls.md is the reference table. When you add
// an action, update all three together.

import type { Action, AudioState, ControlState, LvaSender } from '../types.mjs'

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

/** What a voice action's runner is allowed to touch. */
export interface VoiceContext {
  state: ControlState
  lva: LvaSender
  onStateChange: () => void
}

/**
 * A voice action must carry its behaviour with it. The required `run` makes
 * adding an entry to VOICE_ACTIONS without behaviour a compile error rather
 * than a dead key on the deck.
 */
interface VoiceActionSpec extends ActionSpec {
  run(context: VoiceContext): void
}

const ASSIST_ACTIVE = ['WAKE_WORD_DETECTED', 'LISTENING', 'THINKING', 'TTS_SPEAKING']

/**
 * Voice actions (`type: lva`) sent to the Linux Voice Assistant peripheral
 * socket.
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
    run: ({ lva }) => {
      lva.send('start_listening')
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
    run: ({ state, lva }) => {
      // LVA has no toggle command, so pick the opposite of the mute state it
      // last reported. The resulting `muted` event is what updates our state.
      lva.send(state.muted ? 'unmute_mic' : 'mute_mic')
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
    run: ({ state, lva, onStateChange }) => {
      lva.send(state.media ? 'pause_media_player' : 'resume_media_player')
      // LVA confirms with a media_player_* event, but the key repaints now so
      // the press feels immediate; the event reconciles any disagreement.
      state.media = !state.media
      onStateChange()
    },
  },
  stop: {
    summary: 'Stop everything at once: timer ringing, the pipeline, and media playback.',
    example: '{ type: lva, command: stop }',
    run: ({ state, lva, onStateChange }) => {
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
    run: ({ lva }) => {
      lva.send('stop_timer_ringing')
    },
  },
} as const satisfies Record<string, VoiceActionSpec>

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

/**
 * Runs a voice command: a catalogued action performs the behaviour declared in
 * its entry, and any other command is forwarded to LVA verbatim, so LVA
 * features that need no local bookkeeping are usable without a controller
 * change.
 */
export function runVoiceCommand(command: string, context: VoiceContext): void {
  if (isVoiceAction(command)) VOICE_ACTIONS[command].run(context)
  else context.lva.send(command)
}

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
 * Explains why a bound action is unusable, or null when it is valid.
 * layout.test.mts calls this so a typo fails `make test` with a readable
 * message rather than producing a key that silently does nothing when pressed.
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
