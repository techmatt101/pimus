import { createActionHandler } from './actions.mjs'
import { loadConfig } from './config.mjs'
import { runDeckLoop } from './deck-controller.mjs'
import { DeckRenderer } from './display.mjs'
import { LvaClient } from './lva-client.mjs'
import { ReSpeakerController } from './respeaker.mjs'
import { createState } from './state.mjs'
import { readAudioState, runSmartampctl, startOutputMonitor } from './system-control.mjs'

const config = loadConfig()
const state = createState()

const renderer = new DeckRenderer({
  config: config.streamdeck,
  state,
  readAudioState: () => readAudioState(config.audio_state_file),
})

const respeaker = config.respeaker?.enabled
  ? new ReSpeakerController({ config: config.respeaker })
  : null

const lva = new LvaClient({
  uri: config.lva_uri,
  state,
  onStateChange: () => renderer.schedule(),
  onOpen: () => respeaker?.register(lva),
  onEvent: (message) => respeaker?.handleEvent(message),
  onDisconnect: () => respeaker?.setDisconnected(),
})

const control = (args) => runSmartampctl(args, {
  onExit: () => setTimeout(() => renderer.schedule(), 300),
})

const handleAction = createActionHandler({
  state,
  lva,
  control,
  lights: (command) => respeaker?.command(command),
  webhookBase: config.webhook_base,
  onStateChange: () => renderer.schedule(),
})

respeaker?.start()
if (config.voice_enabled) lva.connect()

if (config.streamdeck?.enabled) {
  startOutputMonitor({ state, onStateChange: () => renderer.schedule() })
  await runDeckLoop({ config: config.streamdeck, renderer, handleAction })
} else {
  // The ReSpeaker watch timer and optional LVA socket do the work in LED-only
  // deployments; this explicit wait documents that the process is a daemon.
  await new Promise(() => {})
}
