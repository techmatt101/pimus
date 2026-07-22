// The playground's composition root. It wires the same controller modules that
// apps/controller/src/index.mts wires on the Pi, but every hardware and service
// boundary is replaced by a fake:
//
//   Stream Deck+ USB      -> fake-deck.mts, drawn in the browser
//   LVA peripheral socket -> fake-lva.mts, a loopback WebSocket server
//   audio manager socket  -> fake-audio-manager.mts, a real Unix socket server
//   wpctl                 -> fake-wpctl.mts, a number instead of a sink
//   ReSpeaker USB LEDs    -> fake-led.mts, drawn as a ring
//   Home Assistant        -> fake-home-assistant.mts, a house that responds,
//                            including the events automations push to the strip
//
// Everything above those boundaries — the deck lifecycle, paging, tiles and
// their mount/unmount, the action catalog, ducking, the LED state machine, the
// optimistic route cache — is the real code, unmodified. This file deliberately
// mirrors index.mts; when that wiring changes, change it here too.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { busLogger, PlaygroundBus, type PlaygroundSnapshot } from './bus.mjs'
import { FakeAudioManager } from './fake-audio-manager.mjs'
import { FakeDeckHardware } from './fake-deck.mjs'
import { CONDITIONS, FakeHomeAssistant } from './fake-home-assistant.mjs'
import { FakeLedRing } from './fake-led.mjs'
import { FakeLvaServer } from './fake-lva.mjs'
import { FakeWpctl } from './fake-wpctl.mjs'
import { PlaygroundServer, type PlaygroundInput } from './server.mjs'

import { VoiceDucker } from '../../controller/src/audio/ducking.mjs'
import { AudioManagerClient } from '../../controller/src/audio/manager-client.mjs'
import { runVolumeCommand, startOutputMonitor } from '../../controller/src/audio/volume.mjs'
import { loadConfig } from '../../controller/src/config.mjs'
import { NOTIFY_EVENT, NotificationCenter } from '../../controller/src/home-assistant/notifications.mjs'
import { RemoteTileServer } from '../../controller/src/remote/server.mjs'
import { ControlModel, createState } from '../../controller/src/state.mjs'
import { runDeckLoop } from '../../controller/src/streamdeck/deck.mjs'
import { createLayout } from '../../controller/src/streamdeck/layout.mjs'
import { DeckRenderer } from '../../controller/src/streamdeck/renderer.mjs'
import { LvaClient } from '../../controller/src/voice/lva-client.mjs'
import { ReSpeakerController } from '../../controller/src/voice/respeaker.mjs'

/**
 * Mirrors the ReSpeaker LED defaults in ansible/inventory/group_vars/all.yml so
 * the ring in the browser shows the colours a provisioned Pi would show.
 */
const LED_STATES = {
  idle: { effect: 'doa', color: '#102030', accent: '#00bcd4' },
  wake_word_detected: { effect: 'breath', color: '#00bcd4' },
  listening: { effect: 'doa', color: '#001018', accent: '#00e5ff' },
  thinking: { effect: 'rainbow', color: '#7c4dff' },
  tts_speaking: { effect: 'breath', color: '#00c853' },
  media_player_playing: { effect: 'single', color: '#1565c0' },
  timer_ticking: { effect: 'single', color: '#ffab00' },
  timer_ringing: { effect: 'breath', color: '#ff6d00' },
  muted: { effect: 'single', color: '#d50000' },
  disconnected: { effect: 'breath', color: '#d50000' },
  pipeline_error: { effect: 'breath', color: '#ff1744' },
}

const argument = (name: string, fallback: string): string => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`))
  return match ? match.slice(name.length + 3) : fallback
}

const bus = new PlaygroundBus()
const temporary = (suffix: string): string => path.join(os.tmpdir(), `pimus-playground-${process.pid}.${suffix}`)
const socketPath = temporary('sock')
const configPath = temporary('json')

const audioManager = new FakeAudioManager({ bus, socketPath })
const lvaServer = new FakeLvaServer({ bus })
const wpctl = new FakeWpctl(bus)
const ledRing = new FakeLedRing(bus)
const hardware = new FakeDeckHardware(bus)
const homeAssistant = new FakeHomeAssistant(bus)

await audioManager.start()
const lvaUri = await lvaServer.start()

// Round-tripping the configuration through the real loader means the playground
// also proves the shape controller.json.j2 renders is one the controller accepts.
await fs.promises.writeFile(configPath, JSON.stringify({
  voice_enabled: true,
  lva_uri: lvaUri,
  audio_socket: socketPath,
  ducking: { enabled: true },
  webhook_base: 'http://home-assistant.playground/api/webhook',
  home_assistant: {
    enabled: false,
    url: '',
  },
  streamdeck: { enabled: true },
  remote: { enabled: true, port: 8470 },
  respeaker: {
    enabled: true,
    vendor_id: 0x2886,
    product_id: 0x001a,
    brightness: 64,
    speed: 2,
    states: LED_STATES,
  },
}, null, 2))
// On the Pi systemd loads these from /etc/smartamp/secrets.env; here they stand
// in for that file, so the playground exercises the same two-source loader.
const config = loadConfig(configPath, { REMOTE_TILES_TOKEN: 'playground' })

// --- the same wiring as apps/controller/src/index.mts ------------------------

const state = createState()

const audio = new AudioManagerClient({
  socketPath: config.audio_socket,
  onStateChange: () => model.notify(),
  logger: busLogger(bus, 'audio'),
})

const model = new ControlModel(state, () => audio.state)

const ducker = config.ducking?.enabled
  ? new VoiceDucker({ setDuck: (active) => audio.setDuck(active) })
  : null

const respeaker = config.respeaker?.enabled
  ? new ReSpeakerController({
    config: config.respeaker,
    voiceEnabled: config.voice_enabled,
    device: ledRing,
    logger: busLogger(bus, 'led'),
  })
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
  reconnectMilliseconds: 1000,
  logger: busLogger(bus, 'lva'),
})

// The same push channel a real automation uses; the browser's notify buttons
// fire the event on the fake Home Assistant and nothing below this line knows
// the difference.
const notifications = new NotificationCenter({
  ha: homeAssistant,
  onChange: () => model.notify(),
  logger: busLogger(bus, 'home-assistant'),
})

// The real remote-tile server, bound to the loopback with a fixed token, so a
// client can put keys on the browser deck without a Pi:
//
//   pnpm --filter pimus-remote-demo start -- --url=ws://127.0.0.1:8470 --token=playground
const remote = config.remote?.enabled
  ? new RemoteTileServer({
    port: config.remote.port,
    token: config.remote.token,
    host: '127.0.0.1',
    onChange: () => model.notify(),
    postNotification: (data) => notifications.post(data),
    logger: busLogger(bus, 'remote'),
  })
  : null

const layout = createLayout({
  model,
  lva,
  notifications,
  ...(remote ? { remote } : {}),
  setSource: (name, command) => {
    audio.setSource(name, command)
  },
  setVolume: (command) => runVolumeCommand(command, {
    onExit: () => model.notify(),
    spawnProcess: wpctl.spawnProcess,
    logger: busLogger(bus, 'wpctl'),
  }),
  // The real client speaks the WebSocket API and has its own tests; what the
  // playground is for is watching the keys, so this replaces the whole service.
  ha: homeAssistant,
  webhookBase: config.webhook_base,
  // The layout binds no webhook today; logging the request keeps one visible
  // the moment someone binds `webhook(...)` to a key.
  request: (url, init) => {
    bus.log('webhook', 'out', `${init?.method ?? 'GET'} ${url}`)
  },
})

const renderer = new DeckRenderer({ layout, model, logger: busLogger(bus, 'deck') })

respeaker?.start()
audio.connect()
notifications.start()
remote?.start()
lva.connect()
startOutputMonitor({ state, onStateChange: () => model.notify(), execute: wpctl.execute })
void runDeckLoop({
  layout,
  renderer,
  listDevices: hardware.listDevices,
  openDevice: hardware.openDevice,
  retryMilliseconds: 500,
  logger: busLogger(bus, 'deck'),
})

// --- the browser side --------------------------------------------------------

function handleInput(input: PlaygroundInput): void {
  if (input.kind === 'key') hardware.pressKey(Number(input.index))
  else if (input.kind === 'lcd') hardware.pressLcd(Number(input.x))
  else if (input.kind === 'dial') {
    const index = Number(input.index)
    if (input.direction === 'press') hardware.pressDial(index)
    else hardware.rotateDial(index, input.direction === 'left' ? -1 : 1)
  } else if (input.kind === 'event') {
    if (input.event === 'start_pipeline') lvaServer.runPipeline()
    else lvaServer.send(input.event, input.data ?? {})
  } else if (input.kind === 'deck') hardware.setPlugged(Boolean(input.plugged))
  else if (input.kind === 'drop') {
    if (input.target === 'lva') lvaServer.dropConnections()
    else audioManager.dropConnections()
  } else if (input.kind === 'entity') {
    homeAssistant.put(String(input.entity), String(input.state), input.attributes ?? {})
  } else if (input.kind === 'weather') {
    const current = homeAssistant.entity('weather.home')?.state ?? CONDITIONS[0]
    const next = CONDITIONS[(CONDITIONS.indexOf(String(current)) + 1) % CONDITIONS.length]
    homeAssistant.put('weather.home', String(next), {
      temperature: Math.round(4 + Math.random() * 22),
    })
  } else if (input.kind === 'notify') {
    homeAssistant.fire(NOTIFY_EVENT, input.data ?? {})
  } else if (input.kind === 'drop-ha') {
    homeAssistant.setConnected(!homeAssistant.connected)
  } else if (input.kind === 'simulate') {
    lvaServer.simulate = Boolean(input.enabled)
    bus.log('system', 'note', `pipeline simulation ${lvaServer.simulate ? 'on' : 'off'}`)
  }
}

const server = new PlaygroundServer({ bus, onInput: handleInput, port: Number(argument('port', '8787')) })
const url = await server.start()

// The panel is polled rather than pushed on change: several of these live in
// modules that have no reason to know the playground exists.
let lastSnapshot = ''
const snapshotTimer = setInterval(() => {
  const snapshot: PlaygroundSnapshot = {
    deckAttached: hardware.attached,
    lvaConnected: lvaServer.connected,
    audioConnected: audio.connected,
    assist: state.assist,
    muted: state.muted,
    volume: state.volume,
    outputMuted: state.outputMuted,
    media: state.media,
    sources: audio.state.sources,
    ducked: audioManager.ducked,
    led: ledRing.appearance,
    homeAssistant: homeAssistant.connected,
    entities: homeAssistant.snapshot(),
  }
  const serialized = JSON.stringify(snapshot)
  if (serialized === lastSnapshot) return
  lastSnapshot = serialized
  bus.state(snapshot)
}, 200)
snapshotTimer.unref()

bus.log('system', 'note', `playground ready at ${url}`)

// Open a browser only when nobody is watching yet. Under `pnpm dev` the process
// restarts on every rebuild, and an already-open page reconnects within the
// stream's retry window — so this opens one tab on the first run and never
// piles up tabs afterwards.
if (!process.argv.includes('--no-open') && (process.platform === 'darwin' || process.platform === 'linux')) {
  const opener = setTimeout(() => {
    if (server.clients > 0) return
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
  }, 1500)
  opener.unref()
}

// Every step here is synchronous: process.exit does not wait for a promise, so
// an async unlink would leave the socket and config file behind on every run.
const shutdown = (): void => {
  server.close()
  lvaServer.close()
  audioManager.close()
  homeAssistant.close()
  fs.rmSync(configPath, { force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
