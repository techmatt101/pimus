import type { Action, ControlState, LvaSender } from './types.mjs'

export interface ActionHandlerOptions {
  state: ControlState
  lva: LvaSender
  control: (args: string[]) => unknown
  webhookBase?: string
  /** Only the request is meaningful here; the response body is ignored. */
  request?: (url: string, init?: { method: string }) => unknown
  onStateChange?: () => void
}

export type ActionHandler = (action: Action | undefined) => Promise<void>

export function createActionHandler({
  state,
  lva,
  control,
  webhookBase = '',
  request = globalThis.fetch,
  onStateChange = () => {},
}: ActionHandlerOptions): ActionHandler {
  return async function handleAction(action) {
    if (!action || action.type === 'noop') return

    if (action.type === 'lva') {
      if (action.command === 'mute_toggle') {
        lva.send(state.muted ? 'unmute_mic' : 'mute_mic')
      } else if (action.command === 'media_toggle') {
        lva.send(state.media ? 'pause_media_player' : 'resume_media_player')
        state.media = !state.media
        onStateChange()
      } else if (action.command === 'stop') {
        lva.send('stop_timer_ringing')
        lva.send('stop_pipeline')
        lva.send('stop_media_player')
        state.media = false
        onStateChange()
      } else if (action.command) {
        lva.send(action.command)
      }
      return
    }

    if (action.type === 'audio' && action.command) {
      control(action.source
        ? ['source', action.source, action.command]
        : ['volume', action.command])
      return
    }

    if (action.type === 'webhook' && webhookBase && action.id) {
      const base = webhookBase.replace(/\/$/, '')
      await request(`${base}/${encodeURIComponent(action.id)}`, { method: 'POST' })
    }
  }
}
