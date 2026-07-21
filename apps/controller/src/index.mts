import { VoiceDucker } from './audio/ducking.mjs'
import { AudioManagerClient } from './audio/manager-client.mjs'
import { runVolumeCommand, startOutputMonitor } from './audio/volume.mjs'
import { loadConfig } from './config.mjs'
import { ControlModel, createState } from './state.mjs'
import { runDeckLoop } from './streamdeck/deck.mjs'
import { createLayout } from './streamdeck/layout.mjs'
import { DeckRenderer } from './streamdeck/renderer.mjs'
import { LvaClient } from './voice/lva-client.mjs'
import { ReSpeakerController } from './voice/respeaker.mjs'

const config = loadConfig()
const state = createState()

const audio = new AudioManagerClient({
  socketPath: config.audio_socket,
  onStateChange: () => model.notify(),
})

// Everything that mutates control-surface state notifies this model; the
// renderer subscribes to repaint, and mounted tiles may subscribe themselves.
const model = new ControlModel(state, () => audio.state)

// No exit handler releases the duck: the manager holds the request against this
// socket, so the kernel closing it on exit or crash restores background audio.
const ducker = config.ducking?.enabled
  ? new VoiceDucker({ setDuck: (active) => audio.setDuck(active) })
  : null

const respeaker = config.respeaker?.enabled
  ? new ReSpeakerController({ config: config.respeaker, voiceEnabled: config.voice_enabled })
  : null

const lva = new LvaClient({
  uri: config.lva_uri,
  state,
  onStateChange: () => model.notify(),
  onEvent: async (message) => {
    ducker?.handleEvent(message)
    await respeaker?.handleEvent(message)
  },
  onDisconnect: async () => {
    ducker?.release()
    await respeaker?.setDisconnected()
  },
})

// The layout is built with the controller's services injected, so every tile
// and dial binding carries its behaviour with it (see streamdeck/tiles/).
const layout = createLayout({
  model,
  lva,
  setSource: (name, command) => {
    audio.setSource(name, command)
  },
  setVolume: (command) => runVolumeCommand(command, { onExit: () => model.notify() }),
  webhookBase: config.webhook_base,
})

const renderer = new DeckRenderer({ layout, model })

respeaker?.start()
audio.connect()
if (config.voice_enabled) lva.connect()

if (config.streamdeck?.enabled) {
  startOutputMonitor({ state, onStateChange: () => model.notify() })
  await runDeckLoop({ layout, renderer })
} else {
  // The ReSpeaker watch timer and optional LVA socket do the work in LED-only
  // deployments; this explicit wait documents that the process is a daemon.
  await new Promise(() => {})
}
