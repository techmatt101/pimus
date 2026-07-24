import {VoiceDucker} from './audio/ducking.mjs'
import {AudioManagerClient} from './audio/manager-client.mjs'
import {runVolumeCommand, startOutputMonitor} from './audio/volume.mjs'
import {loadConfig} from './config.mjs'
import {createOfflineHomeAssistant, HomeAssistantClient} from './home-assistant/client.mjs'
import {NotificationCenter} from './home-assistant/notifications.mjs'
import {RemoteTileServer} from './remote/server.mjs'
import {ControlModel, createState} from './state.mjs'
import {runDeckLoop} from './streamdeck/deck.mjs'
import {createLayout, SLEEP} from './streamdeck/layout.mjs'
import {DeckRenderer} from './streamdeck/renderer.mjs'
import {SleepController} from './streamdeck/sleep.mjs'
import {LvaClient} from './voice/lva-client.mjs'
import {ReSpeakerController} from './voice/respeaker.mjs'

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
    ? new VoiceDucker({setDuck: (active) => audio.setDuck(active)})
    : null

const respeaker = config.respeaker?.enabled
    ? new ReSpeakerController({config: config.respeaker, voiceEnabled: config.voice_enabled})
    : null

// With no Home Assistant configured the tiles that read it keep their places on
// the deck and draw unknown state, so the layout never has to ask whether the
// integration exists.
const homeAssistant = config.home_assistant?.enabled
    ? new HomeAssistantClient({
        url: config.home_assistant.url,
        token: config.home_assistant.token,
        onStateChange: () => model.notify(),
    })
    : createOfflineHomeAssistant()

// Automations reach the touch strip by firing a Home Assistant event; with no
// Home Assistant configured nothing can push one and the strip simply keeps
// showing what is playing.
const notifications = new NotificationCenter({
    ha: homeAssistant,
    onChange: () => model.notify(),
})

// Another computer on the LAN pushes key faces onto the REMOTE page and gets
// presses back over this socket; its notify messages join the same strip queue
// Home Assistant's do. Off unless configured with a shared token, so an
// unconfigured deployment keeps accepting no inbound connections at all.
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

// The layout is built with the controller's services injected, so every tile
// and dial binding carries its behaviour with it (see streamdeck/tiles/).
const layout = createLayout({
    model,
    clock: Date.now,
    lva,
    setSource: (name, command) => {
        audio.setSource(name, command)
    },
    setVolume: (command) => runVolumeCommand(command, {onExit: () => model.notify()}),
    ha: homeAssistant,
    notifications,
    ...(remote ? {remote} : {}),
})

const renderer = new DeckRenderer({layout, model})

respeaker?.start()
audio.connect()
notifications.start()
remote?.start()
if (homeAssistant instanceof HomeAssistantClient) homeAssistant.connect()
if (config.voice_enabled) lva.connect()

if (config.streamdeck?.enabled) {
    // Switches the panel off while the room is empty. Only the deck sleeps: the
    // wake word, the ReSpeaker ring, and background playback keep running, so
    // this belongs to the deck branch and an LED-only unit never starts it.
    const sleep = new SleepController({
        model,
        ha: homeAssistant,
        presenceEntity: SLEEP.presence,
        graceMilliseconds: SLEEP.graceMilliseconds,
    })
    sleep.start()
    startOutputMonitor({state, onStateChange: () => model.notify()})
    await runDeckLoop({layout, renderer, onActivity: () => sleep.touch()})
} else {
    // The ReSpeaker watch timer and optional LVA socket do the work in LED-only
    // deployments; this explicit wait documents that the process is a daemon.
    await new Promise(() => {
    })
}
