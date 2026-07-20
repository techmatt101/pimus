import { createActionHandler } from './actions.mjs'
import { loadConfig } from './config.mjs'
import { runDeckLoop } from './deck-controller.mjs'
import { DeckRenderer } from './display.mjs'
import { LvaClient } from './lva-client.mjs'
import { createState } from './state.mjs'
import { readAudioState, runSmartampctl, startOutputMonitor } from './system-control.mjs'

const config = loadConfig()
const state = createState()

const renderer = new DeckRenderer({
  config,
  state,
  readAudioState: () => readAudioState(config.audio_state_file),
})

const lva = new LvaClient({
  uri: config.lva_uri,
  state,
  onStateChange: () => renderer.schedule(),
})

const control = (args) => runSmartampctl(args, {
  onExit: () => setTimeout(() => renderer.schedule(), 300),
})

const handleAction = createActionHandler({
  state,
  lva,
  control,
  webhookBase: config.webhook_base,
  onStateChange: () => renderer.schedule(),
})

lva.connect()
startOutputMonitor({ state, onStateChange: () => renderer.schedule() })
await runDeckLoop({ config, renderer, handleAction })
