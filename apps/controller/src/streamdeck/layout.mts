import type {RouteActionName} from '../actions/catalog.mjs'
import {isEntityOn, numericAttribute} from '../home-assistant/entity.mjs'
import {type Binding, routeBinding, voiceBinding} from './bindings.mjs'
import type {Dial} from './dial.mjs'
import {DynamicDial} from './dials/dynamic-dial.mjs'
import {MediaDial} from './dials/media-dial.mjs'
import {PageDial} from './dials/page-dial.mjs'
import {VolumeDial} from './dials/volume-dial.mjs'
import type {PageGrid, StreamDeckLayout, StreamDeckPage} from './grid.mjs'
import {IdleScreen} from './screens/idle-screen.mjs'
import {NowPlayingScreen} from './screens/now-playing-screen.mjs'
import {TouchStrip} from './strip.mjs'
import {ActionTile} from './tiles/action-tile.mjs'
import {BrightnessTile} from './tiles/brightness-tile.mjs'
import {EntityToggleTile} from './tiles/entity-toggle-tile.mjs'
import {PlaylistTile} from './tiles/playlist-tile.mjs'
import {RemoteTile} from './tiles/remote-tile.mjs'
import {SceneTile} from './tiles/scene-tile.mjs'
import {TemperatureTile} from './tiles/temperature-tile.mjs'
import {TimerTile} from './tiles/timer-tile.mjs'
import type {Tile} from './tile.mjs'
import {VoiceTile} from './tiles/voice-tile.mjs'
import type {ControlModel} from '../state.mjs'
import type {AudioControls, HomeAssistantService, LvaSender, NotificationFeed, RemoteTileFeed} from '../types.mjs'

const HA = {
    player: 'media_player.house_speakers2',
    lights: 'light.office',
    fan: 'fan.office_ceiling',
    blinds: 'cover.office_blinds',
    pc: 'device_tracker.techmatt_pc',
    timer: 'timer.office',
    presence: 'binary_sensor.office_presence',
    temperature: 'sensor.office_temperature',
    weather: 'weather.met_office_stafford',
    scenes: [
        {label: 'BRIGHT', entity: 'scene.office_bright', color: '#f9a825'},
        {label: 'WORK', entity: 'scene.office_work', color: '#0277bd'},
        {label: 'WARM', entity: 'scene.office_warm', color: '#bf360c'},
        {label: 'OFF', entity: 'scene.office_off', color: '#37474f'},
    ],
    playlists: [
        {label: 'MELLOW', media: {media_content_id: 'library://playlist/1', media_content_type: 'playlist'}},
        {label: 'ROCK', media: {media_content_id: 'library://playlist/2', media_content_type: 'playlist'}},
        {label: 'FOCUS', media: {media_content_id: 'library://playlist/3', media_content_type: 'playlist'}},
    ],
} as const

const TIMER_DURATION = '00:05:00'

export const SLEEP = {
    presence: HA.presence,
    graceMilliseconds: 2 * 60_000,
} as const

export interface ControllerServices {
    model: ControlModel
    clock: () => number
    lva: LvaSender
    audio: AudioControls
    ha: HomeAssistantService
    notifications?: NotificationFeed
    remote?: RemoteTileFeed
}

export function createLayout(services: ControllerServices): StreamDeckLayout {
    const {model, clock, lva, audio, ha, notifications, remote} = services
    const voice = (command: string): Binding => voiceBinding(lva, model, command)
    const route = (source: string, command: RouteActionName): Binding => routeBinding(audio, source, command)
    const key = (label: string, color: string, binding: Binding): Tile =>
        new ActionTile(model, {label, color, binding})

    const dynamic = new DynamicDial(model)

    const mainGrid: PageGrid = [
        [
            new VoiceTile(model, lva),
            new PlaylistTile(ha, dynamic, {player: HA.player, playlists: HA.playlists}),
            new EntityToggleTile(ha, {
                label: 'PC',
                entity: HA.pc,
                icon: 'computer',
                onColor: '#283593',
                offColor: '#151a30',
            }),
            new TimerTile(ha, clock, {entity: HA.timer, duration: TIMER_DURATION}),
        ],
        [
            new SceneTile(ha, {scenes: HA.scenes}),
            new EntityToggleTile(ha, {
                label: 'FAN',
                entity: HA.fan,
                icon: 'fan',
                onColor: '#00695c',
                offColor: '#0d2320',
                spin: (_entity, phase) => (phase % 1200) / 1200,
                animationMilliseconds: 100,
                dial: dynamic,
            }),
            new EntityToggleTile(ha, {
                label: 'BLINDS',
                entity: HA.blinds,
                icon: 'blinds',
                onColor: '#455a64',
                offColor: '#1c2429',
                // A cover reporting no position falls back to fully raised or down.
                level: (entity) => 1 - (numericAttribute(entity, 'current_position') ?? (isEntityOn(entity) ? 80 : 0)) / 100,
                dial: dynamic,
            }),
            new EntityToggleTile(ha, {
                label: 'LIGHTS',
                entity: HA.lights,
                icon: 'bulb',
                onColor: '#6b5200',
                offColor: '#1e1a0c',
                dial: dynamic,
            }),
        ],
    ]

    const infoGrid: PageGrid = [
        [
            key('MIC', '#7f0000', voice('mute_toggle')),
            new TemperatureTile(ha, {label: 'OFFICE', entity: HA.temperature}),
            null,
            new BrightnessTile(model),
        ],
        [
            key('STOP', '#b71c1c', voice('stop')),
            key('AUX', '#4a148c', route('aux', 'toggle')),
            key('USB', '#0d47a1', route('usb', 'toggle')),
            null,
        ],
    ]

    const remoteGrid: PageGrid | null = remote
        ? [
            [
                new RemoteTile(remote, {slot: 0}),
                new RemoteTile(remote, {slot: 1}),
                new RemoteTile(remote, {slot: 2}),
                new RemoteTile(remote, {slot: 3}),
            ],
            [
                null,
                new RemoteTile(remote, {slot: 4}),
                new RemoteTile(remote, {slot: 5}),
                null,
            ],
        ]
        : null

    const pages: StreamDeckPage[] = [
        {name: 'MAIN', grid: mainGrid},
        {name: 'INFO', grid: infoGrid},
        ...(remoteGrid ? [{name: 'REMOTE', grid: remoteGrid}] : []),
    ]

    const dials: Dial[] = [
        new VolumeDial(audio, model),
        new MediaDial(ha, lva, model, {player: HA.player}),
        new PageDial(),
        dynamic,
    ]

    const strip = new TouchStrip({
        resting: [
            new NowPlayingScreen(ha, clock, lva, model, {player: HA.player}),
            new IdleScreen(ha, clock, {weatherEntityId: HA.weather}),
        ],
        dials,
        clock,
        ...(notifications ? {notifications} : {}),
    })

    dynamic.revealOn(() => strip.showDial(dials.indexOf(dynamic)))

    return {pages, dials, strip}
}
