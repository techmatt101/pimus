import { createActionHandler } from './actions.mjs'
import { loadConfig } from './config.mjs'
import { runDeckLoop } from './deck-controller.mjs'
import { DeckRenderer } from './display.mjs'
import { VoiceDucker } from './ducking.mjs'
import { LvaClient } from './lva-client.mjs'
import { ReSpeakerController } from './respeaker.mjs'
import { createState } from './state.mjs'
import { readAudioState, runSmartampctl, startOutputMonitor } from './system-control.mjs'

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

const renderer = new DeckRenderer({
  config: config.streamdeck,
  state,
  readAudioState: () => readAudioState(config.audio_state_file),
})

const respeaker = config.respeaker?.enabled
  ? new ReSpeakerController({ config: config.respeaker, voiceEnabled: config.voice_enabled })
  : null

// Annotated because onOpen refers back to this binding while constructing it.
const lva: LvaClient = new LvaClient({
  uri: config.lva_uri,
  state,
  onStateChange: () => renderer.schedule(),
  onOpen: () => respeaker?.register(lva),
  onEvent: async (message) => {
    ducker?.handleEvent(message)
    await respeaker?.handleEvent(message)
  },
  onDisconnect: async () => {
    ducker?.release()
    await respeaker?.setDisconnected()
  },
})

const control = (args: string[]) => runSmartampctl(args, {
  onExit: () => setTimeout(() => renderer.schedule(), 300),
})

const handleAction = createActionHandler({
  state,
  lva,
  control,
  lights: (command: string) => respeaker?.command(command),
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
