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

import { numericAttribute } from '../home-assistant/entity.mjs'
import type {
  Action,
  AudioState,
  ControlState,
  HomeAssistantService,
  LvaSender,
} from '../types.mjs'

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

/** Assist states that mean a pipeline is running right now. */
export const ASSIST_ACTIVE = ['WAKE_WORD_DETECTED', 'LISTENING', 'THINKING', 'TTS_SPEAKING']

/** Whether the voice pipeline is mid-run, so a listen key cancels rather than starts. */
export const isAssistRunning = (state: ControlState): boolean => ASSIST_ACTIVE.includes(state.assist)

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
      isActive: ({ state }) => isAssistRunning(state),
      activeColor: '#00b8d4',
    },
    run: ({ lva }) => {
      lva.send('start_listening')
    },
  },
  listen_toggle: {
    summary: 'Start a voice pipeline, or cancel the one already running.',
    example: '{ type: lva, command: listen_toggle }',
    indicator: {
      isActive: ({ state }) => isAssistRunning(state),
      activeColor: '#00b8d4',
      label: (configured, active) => (active ? 'CANCEL' : configured),
    },
    run: ({ state, lva }) => {
      // One key for both directions: pressing it while Assist is listening,
      // thinking, or speaking should get rid of it, not queue another pipeline.
      lva.send(isAssistRunning(state) ? 'stop_pipeline' : 'start_listening')
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

/** What a Home Assistant action's runner is allowed to touch. */
export interface HaContext {
  ha: HomeAssistantService
  /** The bound entity id, e.g. `fan.office_ceiling`. */
  entity: string
  /** Extra service data carried by the binding, such as a media id. */
  data?: Record<string, unknown> | undefined
}

/**
 * Like a voice action, a Home Assistant action carries its behaviour, so the
 * service call for an entry lives beside the entry rather than in a dispatcher
 * a new action can forget to reach.
 */
interface HaActionSpec extends ActionSpec {
  run(context: HaContext): void
}

/**
 * An entity id's domain, which is also the domain of the service that acts on
 * it: `fan.office_ceiling` is turned off by `fan.turn_off`. Deriving it means
 * one `toggle` action covers lights, fans, switches, covers, and helpers
 * instead of one catalog entry per domain.
 */
export const entityDomain = (entityId: string): string => entityId.split('.')[0] ?? ''

/** A well-formed entity id: `<domain>.<object_id>`. */
export const ENTITY_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/

/**
 * Checks an entity id as a tile is constructed, so a typo fails while the
 * layout is being built rather than becoming a key that presses successfully
 * and reaches nothing. `describeActionProblem` catches the same mistake in a
 * declared action; this covers tiles that hold several entities and so cannot
 * expose them all as one `action()`.
 */
export function requireEntity(entityId: string, where: string): string {
  if (!ENTITY_ID.test(entityId)) {
    throw new Error(`${where}: "${entityId}" is not a Home Assistant entity id such as "fan.office_ceiling"`)
  }
  return entityId
}

/** How far one step of a light dial moves brightness. */
const BRIGHTNESS_STEP_PERCENT = 10

/** How far one step of a cover dial moves a blind that reports its position. */
const COVER_STEP_PERCENT = 10

/**
 * Moves a cover by one dial step. Home Assistant has no relative service for a
 * cover the way it has `brightness_step_pct` for a light, so the step is applied
 * to the position the cover reports. A blind that reports no position has
 * nothing to step, and gets the plain full open or close instead — better than a
 * dial that silently does nothing.
 */
function stepCover({ ha, entity }: HaContext, step: number): void {
  const position = numericAttribute(ha.entity(entity), 'current_position')
  if (position === undefined) {
    ha.call('cover', step > 0 ? 'open_cover' : 'close_cover', entity)
    return
  }
  ha.call('cover', 'set_cover_position', entity, {
    position: Math.max(0, Math.min(100, Math.round(position + step))),
  })
}

/**
 * Home Assistant actions (`type: ha`). Each targets one entity over the
 * WebSocket API (home-assistant/client.mts), so unlike a `webhook` action they
 * can also be read back — which is what lets the tiles in streamdeck/tiles/
 * show whether the fan is actually running.
 */
export const HA_ACTIONS = {
  toggle: {
    summary: 'Flip an entity on or off: a light, fan, switch, cover, or helper.',
    example: "ha('toggle', 'fan.office_ceiling')",
    run: ({ ha, entity }) => ha.call(entityDomain(entity), 'toggle', entity),
  },
  turn_on: {
    summary: 'Turn an entity on. A cover opens.',
    example: "ha('turn_on', 'switch.office_pc')",
    run: ({ ha, entity, data }) => ha.call(entityDomain(entity), 'turn_on', entity, data),
  },
  turn_off: {
    summary: 'Turn an entity off. A cover closes.',
    example: "ha('turn_off', 'switch.office_pc')",
    run: ({ ha, entity, data }) => ha.call(entityDomain(entity), 'turn_off', entity, data),
  },
  activate: {
    summary: 'Activate a scene or run a script, which have no matching "off".',
    example: "ha('activate', 'scene.office_bright')",
    run: ({ ha, entity, data }) => ha.call(entityDomain(entity), 'turn_on', entity, data),
  },
  play_media: {
    summary: 'Play a media id on a media player, such as a saved playlist.',
    example: "ha('play_media', 'media_player.office', { media_content_id: '...', media_content_type: 'playlist' })",
    run: ({ ha, entity, data }) => ha.call('media_player', 'play_media', entity, data),
  },
  media_next: {
    summary: 'Skip a media player to the next track.',
    example: "ha('media_next', 'media_player.office')",
    run: ({ ha, entity }) => ha.call('media_player', 'media_next_track', entity),
  },
  media_previous: {
    summary: 'Send a media player back to the previous track.',
    example: "ha('media_previous', 'media_player.office')",
    run: ({ ha, entity }) => ha.call('media_player', 'media_previous_track', entity),
  },
  media_shuffle: {
    summary: 'Toggle shuffle on a media player, from the shuffle state it reports.',
    example: "ha('media_shuffle', 'media_player.office')",
    run: ({ ha, entity }) => {
      // shuffle_set takes an absolute value, so ask for the opposite of the
      // last reported one; an unknown player is assumed to be un-shuffled.
      ha.call('media_player', 'shuffle_set', entity, { shuffle: !isShuffled(ha, entity) })
    },
  },
  brightness_up: {
    summary: `Raise a light's brightness by ${BRIGHTNESS_STEP_PERCENT}%.`,
    example: "ha('brightness_up', 'light.office')",
    run: ({ ha, entity }) => {
      ha.call('light', 'turn_on', entity, { brightness_step_pct: BRIGHTNESS_STEP_PERCENT })
    },
  },
  brightness_down: {
    summary: `Lower a light's brightness by ${BRIGHTNESS_STEP_PERCENT}%.`,
    example: "ha('brightness_down', 'light.office')",
    run: ({ ha, entity }) => {
      ha.call('light', 'turn_on', entity, { brightness_step_pct: -BRIGHTNESS_STEP_PERCENT })
    },
  },
  fan_speed_up: {
    summary: "Raise a fan's speed by one of its own steps.",
    example: "ha('fan_speed_up', 'fan.office_ceiling')",
    // No percentage_step: the fan's own step count is what its remote uses, and
    // a three-speed ceiling fan should not need four turns to reach medium.
    run: ({ ha, entity }) => ha.call('fan', 'increase_speed', entity),
  },
  fan_speed_down: {
    summary: "Lower a fan's speed by one of its own steps.",
    example: "ha('fan_speed_down', 'fan.office_ceiling')",
    run: ({ ha, entity }) => ha.call('fan', 'decrease_speed', entity),
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
    run: ({ ha, entity, data }) => {
      // `timer.start` on a running timer restarts it, which is not what a
      // second press of one key should mean.
      const running = ha.entity(entity)?.state
      if (running === 'active' || running === 'paused') ha.call('timer', 'cancel', entity)
      else ha.call('timer', 'start', entity, data)
    },
  },
} as const satisfies Record<string, HaActionSpec>

export type HaActionName = keyof typeof HA_ACTIONS

/** Whether a media player last reported shuffle on. */
export function isShuffled(ha: HomeAssistantService, entityId: string): boolean {
  return Boolean(ha.entity(entityId)?.attributes.shuffle)
}

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

export const isHaAction = (command: string): command is HaActionName => has(HA_ACTIONS, command)

/**
 * Runs a Home Assistant command. Unlike voice commands there is no verbatim
 * fallback: the service call is composed here from the entity's domain, so a
 * command with no catalog entry has no meaning to forward.
 */
export function runHaCommand(command: HaActionName, context: HaContext): void {
  HA_ACTIONS[command].run(context)
}

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

  if (type === 'ha') {
    const { entity } = action as Record<string, unknown>
    if (typeof command !== 'string' || !isHaAction(command)) {
      return `unknown Home Assistant command "${String(command)}"; expected ${Object.keys(HA_ACTIONS).join(', ')}`
    }
    // A mistyped entity id is otherwise a key that silently does nothing, since
    // Home Assistant accepts the service call and finds no target.
    return typeof entity === 'string' && ENTITY_ID.test(entity)
      ? null
      : 'a "ha" action needs an entity id such as "fan.office_ceiling"'
  }

  return `unknown action type "${String(type)}"; expected noop, lva, audio, webhook, or ha`
}
