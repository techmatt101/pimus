// The playground's composition root. It wires the same controller modules that
// apps/controller/src/index.mts wires on the Pi, but every hardware and service
// boundary is replaced by a fake:
//
//   Stream Deck+ USB      -> fake-deck.mts, drawn in the browser
//   LVA peripheral socket -> fake-lva.mts, a loopback WebSocket server
//   audio manager socket  -> fake-audio-manager.mts, a real Unix socket server
//   wpctl                 -> fake-wpctl.mts, a number instead of a sink
//   ReSpeaker USB LEDs    -> fake-led.mts, drawn as a ring
//
// Home Assistant is the one boundary that is NOT faked: the playground runs the
// real WebSocket client against a real instance (HOME_ASSISTANT_URL /
// HOME_ASSISTANT_TOKEN, from the shell or apps/playground/.env), so the deck
// follows a real house. The browser's notification buttons still stand in for an
// automation firing `smartamp_notify`.
//
// Everything above those boundaries — the deck lifecycle, paging, tiles and
// their mount/unmount, the action catalog, ducking, the LED state machine, the
// optimistic route cache — is the real code, unmodified. This file deliberately
// mirrors index.mts; when that wiring changes, change it here too.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'

import {busLogger, PlaygroundBus, type PlaygroundSnapshot} from './bus.mjs'
import {FakeAudioManager} from './fake-audio-manager.mjs'
import {FakeDeckHardware} from './fake-deck.mjs'
import {FakeLedRing} from './fake-led.mjs'
import {FakeLvaServer} from './fake-lva.mjs'
import {FakeWpctl} from './fake-wpctl.mjs'
import {type PlaygroundInput, PlaygroundServer} from './server.mjs'

import {VoiceDucker} from '../../controller/src/audio/ducking.mjs'
import {AudioManagerClient} from '../../controller/src/audio/manager-client.mjs'
import {runVolumeCommand, startOutputMonitor} from '../../controller/src/audio/volume.mjs'
import {loadConfig} from '../../controller/src/config.mjs'
import {HomeAssistantClient} from '../../controller/src/home-assistant/client.mjs'
import {NotificationCenter} from '../../controller/src/home-assistant/notifications.mjs'
import {RemoteTileServer} from '../../controller/src/remote/server.mjs'
import {ControlModel, createState} from '../../controller/src/state.mjs'
import {runDeckLoop} from '../../controller/src/streamdeck/deck.mjs'
import {createLayout, SLEEP} from '../../controller/src/streamdeck/layout.mjs'
import {DeckRenderer} from '../../controller/src/streamdeck/renderer.mjs'
import {SleepController} from '../../controller/src/streamdeck/sleep.mjs'
import {LvaClient} from '../../controller/src/voice/lva-client.mjs'
import {ReSpeakerController} from '../../controller/src/voice/respeaker.mjs'

const argument = (name: string, fallback: string): string => {
    const match = process.argv.find((value) => value.startsWith(`--${name}=`))
    return match ? match.slice(name.length + 3) : fallback
}

/**
 * Fold `KEY=VALUE` lines from a `.env` file into `process.env`, without
 * overriding anything already set in the shell. The playground talks to a real
 * Home Assistant, so this is how the two credentials are supplied: drop them in
 * apps/playground/.env (git-ignored) rather than exporting them by hand. A
 * missing file is fine — the shell environment is then the only source.
 */
function loadEnvFile(file: string): void {
    let contents: string
    try {
        contents = fs.readFileSync(file, 'utf8')
    } catch {
        return
    }
    for (const line of contents.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) continue
        const key = trimmed.slice(0, eq).trim()
        if (process.env[key] !== undefined) continue
        const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
        process.env[key] = value
    }
}

// pnpm runs this script with the package directory as the working directory, so
// the credentials file sits beside package.json at apps/playground/.env.
loadEnvFile(path.join(process.cwd(), '.env'))
const haUrl = process.env.HOME_ASSISTANT_URL
const haToken = process.env.HOME_ASSISTANT_TOKEN
if (!haUrl || !haToken) {
    console.error(
        'The playground drives a real Home Assistant, so it needs one to connect to.\n' +
        'Set HOME_ASSISTANT_URL (e.g. http://homeassistant.local:8123) and a long-lived\n' +
        'HOME_ASSISTANT_TOKEN — in your shell or in apps/playground/.env (see .env.example).',
    )
    process.exit(1)
}

const bus = new PlaygroundBus()
const temporary = (suffix: string): string => path.join(os.tmpdir(), `pimus-playground-${process.pid}.${suffix}`)
const socketPath = temporary('sock')
const configPath = temporary('json')

const audioManager = new FakeAudioManager({bus, socketPath})
const lvaServer = new FakeLvaServer({bus})
const wpctl = new FakeWpctl(bus)
const ledRing = new FakeLedRing(bus)
const hardware = new FakeDeckHardware(bus)

await audioManager.start()
const lvaUri = await lvaServer.start()

// Round-tripping the configuration through the real loader means the playground
// also proves the shape controller.json.j2 renders is one the controller accepts.
await fs.promises.writeFile(configPath, JSON.stringify({
    voice_enabled: true,
    lva_uri: lvaUri,
    audio_socket: socketPath,
    ducking: {enabled: true},
    home_assistant: {
        enabled: true,
        url: haUrl,
    },
    streamdeck: {enabled: true},
    remote: {enabled: true, port: 8470},
    respeaker: {
        enabled: true,
        vendor_id: 0x2886,
        product_id: 0x001a,
        brightness: 64,
    },
}, null, 2))
// On the Pi systemd loads these from /etc/smartamp/secrets.env; here they stand
// in for that file, so the playground exercises the same two-source loader.
const config = loadConfig(configPath, {REMOTE_TILES_TOKEN: 'playground', HOME_ASSISTANT_TOKEN: haToken})

// --- the same wiring as apps/controller/src/index.mts ------------------------

const state = createState()

const audio = new AudioManagerClient({
    socketPath: config.audio_socket,
    onStateChange: () => model.notify(),
    logger: busLogger(bus, 'audio'),
})

const model = new ControlModel(state, () => audio.state)

// The real Home Assistant client, pointed at the instance the credentials name.
// This is the one boundary the playground does not fake: the deck follows a real
// house, and the same WebSocket client the Pi runs proves the connection here.
const homeAssistant = new HomeAssistantClient({
    url: haUrl,
    token: haToken,
    onStateChange: () => model.notify(),
    reconnectMilliseconds: 1000,
    logger: busLogger(bus, 'home-assistant'),
})

const ducker = config.ducking?.enabled
    ? new VoiceDucker({setDuck: (active) => audio.setDuck(active)})
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
    clock: Date.now,
    lva,
    notifications,
    ...(remote ? {remote} : {}),
    audio: {
        setSource: (name, command) => {
            audio.setSource(name, command)
        },
        setVolume: (command) => runVolumeCommand(command, {
            onExit: () => model.notify(),
            spawnProcess: wpctl.spawnProcess,
            logger: busLogger(bus, 'wpctl'),
        }),
    },
    // The real client speaks the WebSocket API and has its own tests; what the
    // playground is for is watching the keys, so this replaces the whole service.
    ha: homeAssistant,
})

const renderer = new DeckRenderer({layout, model, logger: busLogger(bus, 'deck')})

respeaker?.start()
audio.connect()
homeAssistant.connect()
notifications.start()
remote?.start()
lva.connect()
startOutputMonitor({state, onStateChange: () => model.notify(), execute: wpctl.execute})
// The real sleep policy, on a grace period short enough to watch: the panel is
// meant to outstay you by minutes, which is no way to develop against it.
const sleep = new SleepController({
    model,
    ha: homeAssistant,
    presenceEntity: SLEEP.presence,
    graceMilliseconds: 5000,
})
sleep.start()

void runDeckLoop({
    layout,
    renderer,
    onActivity: () => sleep.touch(),
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
    } else if (input.kind === 'notify') {
        // Stands in for an automation firing `smartamp_notify`: the browser hands
        // the payload straight to the same queue the event listener feeds.
        notifications.post(input.data ?? {})
    } else if (input.kind === 'simulate') {
        lvaServer.simulate = Boolean(input.enabled)
        bus.log('system', 'note', `pipeline simulation ${lvaServer.simulate ? 'on' : 'off'}`)
    }
}

const server = new PlaygroundServer({bus, onInput: handleInput, port: Number(argument('port', '8787'))})
const url = await server.start()

// The panel is polled rather than pushed on change: several of these live in
// modules that have no reason to know the playground exists.
let lastSnapshot = ''
const snapshotTimer = setInterval(() => {
    const snapshot: PlaygroundSnapshot = {
        deckAttached: hardware.attached,
        deckBrightness: hardware.brightness,
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
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {stdio: 'ignore', detached: true}).unref()
    }, 1500)
    opener.unref()
}

// Every step here is synchronous: process.exit does not wait for a promise, so
// an async unlink would leave the socket and config file behind on every run.
const shutdown = (): void => {
    server.close()
    lvaServer.close()
    audioManager.close()
    fs.rmSync(configPath, {force: true})
    process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
