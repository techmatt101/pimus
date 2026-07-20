export function createActionHandler({
  state,
  lva,
  control,
  webhookBase = '',
  request = globalThis.fetch,
  onStateChange = () => {},
}) {
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
      } else {
        lva.send(action.command)
      }
      return
    }

    if (action.type === 'audio') {
      control(action.source
        ? ['source', action.source, action.command]
        : ['volume', action.command])
      return
    }

    if (action.type === 'led') {
      control(['lights', action.command])
      return
    }

    if (action.type === 'webhook' && webhookBase && action.id) {
      const base = webhookBase.replace(/\/$/, '')
      await request(`${base}/${encodeURIComponent(action.id)}`, { method: 'POST' })
    }
  }
}
