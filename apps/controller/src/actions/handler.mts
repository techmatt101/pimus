import { isVoiceAction, type VoiceActionName } from './catalog.mjs'
import type { Action, ControlState, LvaSender } from '../types.mjs'

/** What a voice action runner is allowed to touch. */
interface VoiceContext {
  state: ControlState
  lva: LvaSender
  onStateChange: () => void
}

type VoiceRunner = (context: VoiceContext) => void

/**
 * One runner per catalogued voice action. The Record type is exhaustive over
 * VoiceActionName, so adding an entry to VOICE_ACTIONS without giving it
 * behaviour here is a compile error rather than a dead key on the deck.
 */
const VOICE_RUNNERS: Record<VoiceActionName, VoiceRunner> = {
  start_listening: ({ lva }) => {
    lva.send('start_listening')
  },
  stop_timer_ringing: ({ lva }) => {
    lva.send('stop_timer_ringing')
  },
  mute_toggle: ({ state, lva }) => {
    // LVA has no toggle command, so pick the opposite of the mute state it
    // last reported. The resulting `muted` event is what updates our state.
    lva.send(state.muted ? 'unmute_mic' : 'mute_mic')
  },
  media_toggle: ({ state, lva, onStateChange }) => {
    lva.send(state.media ? 'pause_media_player' : 'resume_media_player')
    // LVA confirms with a media_player_* event, but the key repaints now so the
    // press feels immediate; the event reconciles any disagreement.
    state.media = !state.media
    onStateChange()
  },
  stop: ({ state, lva, onStateChange }) => {
    lva.send('stop_timer_ringing')
    lva.send('stop_pipeline')
    lva.send('stop_media_player')
    state.media = false
    onStateChange()
  },
}

export interface ActionHandlerOptions {
  state: ControlState
  lva: LvaSender
  /** Applies on/off/toggle to a named audio route via the audio manager socket. */
  setSource: (name: string, command: string) => unknown
  /** Applies up/down/mute to the PipeWire default sink. */
  setVolume: (command: string) => unknown
  webhookBase?: string
  /** Only the request is meaningful here; the response body is ignored. */
  request?: (url: string, init?: { method: string }) => unknown
  onStateChange?: () => void
}

export type ActionHandler = (action: Action | undefined) => Promise<void>

/**
 * Runs a configured action. The action shapes and their meanings are declared
 * in actions/catalog.mts; config.mts has already rejected anything invalid by
 * the time an action reaches here.
 */
export function createActionHandler({
  state,
  lva,
  setSource,
  setVolume,
  webhookBase = '',
  request = globalThis.fetch,
  onStateChange = () => {},
}: ActionHandlerOptions): ActionHandler {
  const voiceContext: VoiceContext = { state, lva, onStateChange }

  return async function handleAction(action) {
    if (!action || action.type === 'noop') return

    if (action.type === 'lva' && action.command) {
      const runner = isVoiceAction(action.command) ? VOICE_RUNNERS[action.command] : null
      // Commands with no catalog entry are forwarded verbatim, so LVA features
      // that need no local bookkeeping are usable without a controller change.
      if (runner) runner(voiceContext)
      else lva.send(action.command)
      return
    }

    if (action.type === 'audio' && action.command) {
      if (action.source) setSource(action.source, action.command)
      else setVolume(action.command)
      return
    }

    if (action.type === 'webhook' && webhookBase && action.id) {
      const base = webhookBase.replace(/\/$/, '')
      await request(`${base}/${encodeURIComponent(action.id)}`, { method: 'POST' })
    }
  }
}
