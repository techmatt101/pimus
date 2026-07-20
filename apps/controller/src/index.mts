import { createActionHandler } from './actions/handler.mjs'
import { VoiceDucker } from './audio/ducking.mjs'
import { AudioManagerClient } from './audio/manager-client.mjs'
import { runVolumeCommand, startOutputMonitor } from './audio/volume.mjs'
import { loadConfig } from './config.mjs'
import { createState } from './state.mjs'
import { runDeckLoop } from './streamdeck/deck.mjs'
import { DeckRenderer } from './streamdeck/renderer.mjs'
import { LvaClient } from './voice/lva-client.mjs'
import { ReSpeakerController } from './voice/respeaker.mjs'

const config = loadConfig()
const state = createState()

const audio = new AudioManagerClient({
  socketPath: config.audio_socket,
  onStateChange: () => renderer.schedule(),
})

// No exit handler releases the duck: the manager holds the request against this
// socket, so the kernel closing it on exit or crash restores background audio.
const ducker = config.ducking?.enabled
  ? new VoiceDucker({ setDuck: (active) => audio.setDuck(active) })
  : null

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
