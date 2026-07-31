import {PowerButton} from '../power-button.mjs'
import {RemoteTileServer} from '../remote/server.mjs'
import type {ControlModel} from '../state.mjs'
import type {
    AudioControls,
    HomeAssistantService,
    LvaSender,
    NotificationFeed,
    RemoteConfig,
    SleepDeployment,
} from '../types.mjs'
import {UsbPower} from '../usb-power.mjs'
import {AutoBrightness} from './auto-brightness.mjs'
import {runDeckLoop} from './deck.mjs'
import {BRIGHTNESS, createLayout, SLEEP} from './layout.mjs'
import {DeckRenderer} from './renderer.mjs'
import {SleepController} from './sleep.mjs'

export interface ControlSurfaceServices {
    model: ControlModel
    clock: () => number
    lva: LvaSender
    audio: AudioControls
    ha: HomeAssistantService
    notifications: NotificationFeed
    postNotification(data: Record<string, unknown>): void
    setStandby(suspended: boolean): void
    shutdown(): void
    reboot(): void
    /** Hand a ReSpeaker back that lost its USB power while the panel was off. */
    reattachRespeaker(): void
    sleep?: SleepDeployment
    remote?: RemoteConfig
}

export interface ControlSurface {
    /** The deck retains its last image, so the panel must be handed back before exit. */
    releasePanel(): Promise<void>

    run(): Promise<never>
}

/**
 * Everything the Stream Deck brings with it: the layout and its renderer, the
 * panel's standby and sleep behaviour, the power button that toggles it, and
 * the remote-tile listener that paints into it. This is the whole of what
 * `index.mts` imports for a deck, and it is imported only when one is
 * configured — the deck libraries and the canvas the faces are drawn on are
 * optional dependencies a deck-less unit never installs.
 */
export function createControlSurface({
    model,
    clock,
    lva,
    audio,
    ha,
    notifications,
    postNotification,
    setStandby,
    shutdown,
    reboot,
    reattachRespeaker,
    sleep: sleepConfig,
    remote: remoteConfig,
}: ControlSurfaceServices): ControlSurface {
    const sleep = new SleepController({
        model,
        ha,
        presenceEntity: SLEEP.presence,
        standbyMilliseconds: SLEEP.standbyMilliseconds,
        sleepMilliseconds: SLEEP.sleepMilliseconds,
    })

    const brightness = new AutoBrightness({
        model,
        ha,
        clock,
        illuminanceEntity: BRIGHTNESS.illuminance,
        minPercent: BRIGHTNESS.minPercent,
        maxPercent: BRIGHTNESS.maxPercent,
        brightLux: BRIGHTNESS.brightLux,
        jumpPercent: BRIGHTNESS.jumpPercent,
        settleMilliseconds: BRIGHTNESS.settleMilliseconds,
    })

    const remote = remoteConfig?.enabled
        ? new RemoteTileServer({
            port: remoteConfig.port,
            token: remoteConfig.token,
            onChange: () => model.notify(),
            postNotification,
        })
        : null

    const layout = createLayout({
        model,
        clock,
        lva,
        audio,
        ha,
        notifications,
        power: {
            forceSleep: () => sleep.forceSleep(),
            shutdown,
            reboot,
        },
        ...(remote ? {remote} : {}),
    })

    const renderer = new DeckRenderer({layout, model, dimPercent: SLEEP.dimPercent})

    const usbPower = new UsbPower({
        enabled: sleepConfig?.usb_power_off === true,
        ports: sleepConfig?.usb_ports ?? [],
    })

    return {
        releasePanel: () => renderer.releasePanel(),
        run: () => {
            remote?.start()
            sleep.start()
            brightness.start()
            // Standby (dim) suspends the amp bridges; sleep (off) also cuts USB
            // power, and leaving it hands a rebooted ReSpeaker back to the controller.
            let lastPanel = model.state.panel
            model.subscribe(() => {
                const panel = model.state.panel
                setStandby(panel !== 'lit')
                usbPower.set(panel !== 'off')
                if (lastPanel === 'off' && panel !== 'off') reattachRespeaker()
                lastPanel = panel
            })
            setStandby(model.state.panel !== 'lit')
            usbPower.set(model.state.panel !== 'off')
            new PowerButton({onPress: () => sleep.pressPowerButton()}).start()
            return runDeckLoop({layout, renderer, onActivity: () => sleep.touch()})
        },
    }
}
