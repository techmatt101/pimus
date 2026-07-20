import { createActionHandler } from './actions.mjs'
import { AudioManagerClient } from './audio-manager-client.mjs'
import { loadConfig } from './config.mjs'
import { runDeckLoop } from './deck-controller.mjs'
import { DeckRenderer } from './display.mjs'
import { VoiceDucker } from './ducking.mjs'
import { LvaClient } from './lva-client.mjs'
import { ReSpeakerController } from './respeaker.mjs'
import { createState } from './state.mjs'
import { runVolumeCommand, startOutputMonitor } from './system-control.mjs'

const config = loadConfig()
const state = createState()

const ducker = config.ducking?.enabled
  ? new VoiceDucker({
      stateFile: config.ducking.state_file,
      refreshMilliseconds: config.ducking.refresh_milliseconds,
    })
  : null
ducker?.release()
if (ducker) {
  const releaseAndExit = (): void => {
    ducker.release()
    process.exit(0)
  }
  process.once('SIGTERM', releaseAndExit)
  process.once('SIGINT', releaseAndExit)
}

const audio = new AudioManagerClient({
  socketPath: config.audio_socket,
  onStateChange: () => renderer.schedule(),
})

const renderer = new DeckRenderer({
  config: config.streamdeck,
  state,
  readAudioState: () => audio.state,
})

const respeaker = config.respeaker?.enabled
  ? new ReSpeakerController({ config: config.respeaker, voiceEnabled: config.voice_enabled })
  : null

const lva = new LvaClient({
  uri: config.lva_uri,
  state,
  onStateChange: () => renderer.schedule(),
  onEvent: async (message) => {
    ducker?.handleEvent(message)
    await respeaker?.handleEvent(message)
  },
  onDisconnect: async () => {
    ducker?.release()
    await respeaker?.setDisconnected()
  },
})

const handleAction = createActionHandler({
  state,
  lva,
  setSource: (name, command) => {
    audio.setSource(name, command)
  },
  setVolume: (command) => runVolumeCommand(command, { onExit: () => renderer.schedule() }),
  webhookBase: config.webhook_base,
  onStateChange: () => renderer.schedule(),
})

respeaker?.start()
audio.connect()
if (config.voice_enabled) lva.connect()

if (config.streamdeck?.enabled) {
  startOutputMonitor({ state, onStateChange: () => renderer.schedule() })
  await runDeckLoop({ config: config.streamdeck, renderer, handleAction })
} else {
  // The ReSpeaker watch timer and optional LVA socket do the work in LED-only
  // deployments; this explicit wait documents that the process is a daemon.
  await new Promise(() => {})
}
