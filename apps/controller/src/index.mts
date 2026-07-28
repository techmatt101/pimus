import {VoiceDucker} from './audio/ducking.mjs'
import {AudioManagerClient} from './audio/manager-client.mjs'
import {loadConfig} from './config.mjs'
import {defaultRouteExists, HealthMonitor} from './health.mjs'
import {createOfflineHomeAssistant, HomeAssistantClient} from './home-assistant/client.mjs'
import {NotificationCenter} from './home-assistant/notifications.mjs'
import {logger} from './log.mjs'
import {RemoteTileServer} from './remote/server.mjs'
import {ControlModel, createState} from './state.mjs'
import {runDeckLoop} from './streamdeck/deck.mjs'
import {createLayout, SLEEP} from './streamdeck/layout.mjs'
import {DeckRenderer} from './streamdeck/renderer.mjs'
import {SleepController} from './streamdeck/sleep.mjs'
import {LvaClient} from './voice/lva-client.mjs'
import {ReSpeakerController} from './voice/respeaker.mjs'

const log = logger('main')

// A crash must reach the journal and hand the process back to systemd rather
// than leave a half-alive daemon holding the deck's last image.
process.on('uncaughtException', (error) => {
    log.error('uncaught exception', error)
    process.exit(1)
})
process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason)
    process.exit(1)
})

const config = loadConfig()
const state = createState()

const audio = new AudioManagerClient({
    socketPath: config.audio_socket,
    onStateChange: () => {
        state.outputMuted = audio.state.outputMuted === true
        model.notify()
    },
})

const model = new ControlModel(state, () => audio.state)

// No exit handler releases the duck: the manager holds the request against this
// socket, so the kernel closing it on exit or crash restores background audio.
const ducker = config.ducking?.enabled
    ? new VoiceDucker({setDuck: (active) => audio.setDuck(active)})
    : null

const respeaker = config.respeaker?.enabled
    ? new ReSpeakerController({config: config.respeaker, voiceEnabled: config.voice_enabled})
    : null

const homeAssistant = config.home_assistant?.enabled
    ? new HomeAssistantClient({
        url: config.home_assistant.url,
        token: config.home_assistant.token,
        onStateChange: () => model.notify(),
    })
    : createOfflineHomeAssistant()

const notifications = new NotificationCenter({
    ha: homeAssistant,
    onChange: () => model.notify(),
})

const remote = config.remote?.enabled
    ? new RemoteTileServer({
        port: config.remote.port,
        token: config.remote.token,
        onChange: () => model.notify(),
        postNotification: (data) => notifications.post(data),
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
})

const layout = createLayout({
    model,
    clock: Date.now,
    lva,
    audio: {
        setSource: (name, command) => {
            audio.setSource(name, command)
        },
        // The output sink stays pinned at 100%: loudness lives on the audio
        // manager's music and voice gains, and mute lives on the sink itself.
        setVolume: (command) => {
            if (command === 'mute') {
                return audio.setOutputMute(audio.state.outputMuted !== true)
            }
            const current = audio.state.musicVolume
            if (current === undefined) return
            return audio.setMusicVolume(current + (command === 'up' ? 5 : -5))
        },
        setVoiceVolume: (percent) => {
            audio.setVoiceVolume(percent)
        },
    },
    ha: homeAssistant,
    notifications,
    ...(remote ? {remote} : {}),
})

const renderer = new DeckRenderer({layout, model})

const health = new HealthMonitor({
    model,
    notifications,
    sources: {
        network: () => defaultRouteExists(),
        // A deployment without Home Assistant keeps its icon healthy rather
        // than flagging an integration that was never configured.
        ha: config.home_assistant?.enabled ? () => homeAssistant.connected : () => true,
        audio: () => audio.connected,
        usbPlayback: () => audio.state.usbPlayback === true,
    },
})

respeaker?.start()
audio.connect()
notifications.start()
health.start()
remote?.start()
if (homeAssistant instanceof HomeAssistantClient) homeAssistant.connect()
if (config.voice_enabled) lva.connect()

if (config.streamdeck?.enabled) {
    const sleep = new SleepController({
        model,
        ha: homeAssistant,
        presenceEntity: SLEEP.presence,
        graceMilliseconds: SLEEP.graceMilliseconds,
    })
    sleep.start()
    await runDeckLoop({layout, renderer, onActivity: () => sleep.touch()})
} else {
    // LED-only deployments: the ReSpeaker watch timer and LVA socket do the
    // work; this wait keeps the process a daemon.
    await new Promise(() => {
    })
}
