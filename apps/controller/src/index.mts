import {VoiceDucker} from './audio/ducking.mjs'
import {AudioManagerClient} from './audio/manager-client.mjs'
import {loadConfig} from './config.mjs'
import {defaultRouteExists, HealthMonitor} from './health.mjs'
import {createOfflineHomeAssistant, HomeAssistantClient} from './home-assistant/client.mjs'
import {NotificationCenter} from './home-assistant/notifications.mjs'
import {logger} from './log.mjs'
import {PowerButton} from './power-button.mjs'
import {RemoteTileServer} from './remote/server.mjs'
import {ControlModel, createState} from './state.mjs'
import {SystemPower} from './system-power.mjs'
import {runDeckLoop} from './streamdeck/deck.mjs'
import {createLayout, SLEEP} from './streamdeck/layout.mjs'
import {DeckRenderer} from './streamdeck/renderer.mjs'
import {SleepController} from './streamdeck/sleep.mjs'
import {UsbPower} from './usb-power.mjs'
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
    ? new ReSpeakerController({
        config: config.respeaker,
        voiceEnabled: config.voice_enabled,
        speechLevel: () => audio.voiceLevel,
        onSpeechMeter: (active) => audio.setVoiceMeter(active),
    })
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

const sleep = new SleepController({
    model,
    ha: homeAssistant,
    presenceEntity: SLEEP.presence,
    standbyMilliseconds: SLEEP.standbyMilliseconds,
    sleepMilliseconds: SLEEP.sleepMilliseconds,
})

const systemPower = new SystemPower()

const layout = createLayout({
    model,
    clock: Date.now,
    lva,
    power: {
        forceSleep: () => sleep.forceSleep(),
        shutdown: () => systemPower.shutdown(),
    },
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

// A bare SIGTERM would kill the process with our last face still lit and the
// ring still coloured, which reads as a controller that is running. Hand both
// surfaces back, but never let a stuck USB write hold up the stop.
const shutdown = (): void => {
    void Promise.race([
        Promise.all([renderer.releasePanel(), respeaker?.release()]),
        new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).finally(() => process.exit(0))
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

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
    const usbPower = new UsbPower({
        enabled: config.sleep?.usb_power_off === true,
        ports: config.sleep?.usb_ports ?? [],
    })
    sleep.start()
    // Standby (dim) suspends the amp bridges; sleep (off) also cuts USB power,
    // and leaving it hands a rebooted ReSpeaker back to the controller.
    let lastPanel = model.state.panel
    model.subscribe(() => {
        const panel = model.state.panel
        audio.setStandby(panel !== 'lit')
        usbPower.set(panel !== 'off')
        if (lastPanel === 'off' && panel !== 'off') void respeaker?.reattach()
        lastPanel = panel
    })
    audio.setStandby(model.state.panel !== 'lit')
    usbPower.set(model.state.panel !== 'off')
    const powerButton = new PowerButton({onPress: () => sleep.pressPowerButton()})
    powerButton.start()
    await runDeckLoop({layout, renderer, onActivity: () => sleep.touch()})
} else {
    // LED-only deployments: the ReSpeaker watch timer and LVA socket do the
    // work; this wait keeps the process a daemon.
    await new Promise(() => {
    })
}
