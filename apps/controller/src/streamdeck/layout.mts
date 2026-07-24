// The Stream Deck+ layout: what every key and dial does, and how bright the
// panel sits. This is the file to edit when you want to change the controls.
//
// It is compiled into the controller, so a change ships with `make
// deploy-controller` (or `make provision`). In return the layout is
// type-checked: the `route`/`volume`/`ha` builders only accept commands that
// exist in actions/catalog.mts, a malformed entity id throws while the layout is
// being built, and a test rejects any key or dial the catalog does not
// understand before it can reach the device. Whether a deck is driven at all
// stays a deployment choice in `streamdeck_enabled` (ansible inventory); this
// file only describes the surface.
//
// The physical panel is a 4x2 key grid, 4 dials, and a touch strip above the
// dials. Each dial reacts to three inputs: `left` (counter-clockwise), `right`
// (clockwise), and `press` (also fired by tapping the strip above it). See
// docs/controls.md for every action and the key/dial feedback each produces.
//
// The strip is one full-width display rather than four labels: it shows what is
// playing, swaps to the dial you are turning while you turn it, and shows a
// notification pushed from Home Assistant while one is live.
//
// Keys are paged; dials are not. The third dial pages the grid (PageDial), so
// every one of the eight keys is free to carry a page's tiles, named as a grid:
//
//     [ topLeft    ][ topMidLeft    ][ topMidRight    ][ topRight    ]
//     [ bottomLeft ][ bottomMidLeft ][ bottomMidRight ][ bottomRight ]
//
// Every key is a Tile (streamdeck/tiles/) that runs its own behaviour and
// renders its own face: a plain `key(...)` for a fixed button, or a dynamic
// tile such as `MediaTile` or `TimerTile`. The dials keep their bindings on
// every page, so volume and transport are always one turn away whichever page
// is showing. The fourth dial is the exception: it has no fixed job and
// controls whichever of the lights, fan, or blinds you last pressed
// (streamdeck/dials/dynamic-dial.mts). Every dial is a Dial class in
// streamdeck/dials/, the rotary counterpart of a Tile: it owns what turning it
// does and what it reads out, so the strip never has to work that out.


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

/**
 * The Home Assistant entities this layout drives. They are compiled in with the
 * rest of the layout rather than living in inventory: which fan a key toggles
 * is part of what the key *is*, and keeping it here means a typo is caught by
 * `make test` instead of by a key that presses successfully and reaches
 * nothing. Only the connection itself (`home_assistant_url` and
 * `home_assistant_token`) is inventory configuration.
 *
 * Change these to the entity ids in your own Home Assistant.
 */
const HA = {
    /** The Music Assistant player this deck controls. */
    player: 'media_player.house_speakers2',
    lights: 'light.office',
    fan: 'fan.office_ceiling',
    blinds: 'cover.office_blinds',
    /** A wake-on-LAN switch, so the key both starts the PC and reports it. */
    pc: 'device_tracker.techmatt_pc',
    timer: 'timer.office',
    /** Reads `on` while somebody is in the room; the panel sleeps when it clears. */
    presence: 'binary_sensor.office_presence',
    temperature: 'sensor.office_temperature',
    weather: 'weather.met_office_stafford',
    scenes: [
        {label: 'BRIGHT', entity: 'scene.office_bright', color: '#f9a825'},
        {label: 'WORK', entity: 'scene.office_work', color: '#0277bd'},
        {label: 'WARM', entity: 'scene.office_warm', color: '#bf360c'},
        {label: 'OFF', entity: 'scene.office_off', color: '#37474f'},
    ],
    /**
     * The playlists the music key chooses between: press it to arm, turn the
     * dynamic dial to pick, press again to play. Take each id from Music
     * Assistant; a single entry is fine, it just becomes press-then-confirm.
     */
    playlists: [
        {label: 'MELLOW', media: {media_content_id: 'library://playlist/1', media_content_type: 'playlist'}},
        {label: 'ROCK', media: {media_content_id: 'library://playlist/2', media_content_type: 'playlist'}},
        {label: 'FOCUS', media: {media_content_id: 'library://playlist/3', media_content_type: 'playlist'}},
    ],
} as const

/** How long a press of the timer key starts the Home Assistant timer for. */
const TIMER_DURATION = '00:05:00'

/**
 * When the panel switches itself off (streamdeck/sleep.mts). Compiled in with
 * the rest of the layout because how long a lit deck outstays you is part of
 * what the surface is, and because the entity belongs beside the others above.
 * Clear `presence` to keep the deck lit permanently.
 */
export const SLEEP = {
    presence: HA.presence,
    /** How long the panel stays lit after the room empties. */
    graceMilliseconds: 2 * 60_000,
} as const

/**
 * Builds the layout with the controller's services injected, so every tile and
 * dial binding carries its behaviour with it. The `voice`, `volume`, `route`,
 * and `ha` builders close over those services; `key` places a fixed labelled
 * tile whose feedback (mute and route colour changes) comes from the bound
 * action's catalog indicator. Voice commands are a free string because anything
 * uncatalogued is forwarded to LVA verbatim (see actions/catalog.mts); routes,
 * volume, and Home Assistant commands are checked against the catalog at
 * compile time.
 */
/**
 * The controller's domain services, threaded in here at the one composition root
 * and handed down to each tile, dial, and screen as the narrow slice it actually
 * uses — the model, the Home Assistant service, the voice transport, the
 * amplifier's audio controls — rather than as one bag every leaf depends on. The
 * layout is where they are wired together; nothing below it sees the whole set.
 */
export interface ControllerServices {
    /** The observable control-surface model; mutate its state, then notify. */
    model: ControlModel
    /**
     * Wall-clock milliseconds, injected so a face that shows the time of day or
     * counts down to an instant (the clock strip, the timer key) can be pinned in
     * a test. Decorative animation uses the `deltaTime` a draw is handed instead.
     */
    clock: () => number
    /** The voice transport LVA commands are sent over. */
    lva: LvaSender
    /** The amplifier's master volume and route toggles. */
    audio: AudioControls
    /**
     * Reads entity state and calls services. Always present: a deployment with no
     * Home Assistant configured gets the offline stand-in, so a tile never has to
     * ask whether the integration exists.
     */
    ha: HomeAssistantService
    /**
     * Messages pushed from Home Assistant for the touch strip. Optional: a
     * deployment with no Home Assistant simply never has one, and the strip falls
     * back to what is playing.
     */
    notifications?: NotificationFeed
    /**
     * Key faces pushed over the remote-tile socket (remote/server.mts). Optional,
     * and unlike Home Assistant its absence removes the surface: the layout only
     * builds the REMOTE page when the feature is configured.
     */
    remote?: RemoteTileFeed
}

export function createLayout(services: ControllerServices): StreamDeckLayout {
    const {model, clock, lva, audio, ha, notifications, remote} = services
    // `voice` and `route` build a binding from just the one service each needs:
    // MAIN carries a dedicated AUX and USB key, each toggling its own route.
    const voice = (command: string): Binding => voiceBinding(lva, model, command)
    const route = (source: string, command: RouteActionName): Binding => routeBinding(audio, source, command)
    const key = (label: string, color: string, binding: Binding): Tile =>
        new ActionTile(model, {label, color, binding})

    // The one dial with no fixed job. The lights, fan, and blinds keys below hand
    // it their entity as they are pressed, so a single knob dims, changes speed,
    // and opens without the deck needing a dial for each.
    const dynamic = new DynamicDial(model)

    // Each page is a 2x4 grid laid out like the panel: the top row of four keys,
    // then the bottom, with `null` for a blank slot. Every tile keeps its grid
    // position across pages, so adding a page never reshuffles the keys already
    // placed. A cell holds any Tile: a plain `key(...)` or a dynamic one that draws
    // its own face from live state, such as TimerTile. The third dial pages between
    // them.

    // Everything you reach for while music is playing or you are talking to the
    // house. Play/pause and shuffle are not keys: they live on the now-playing
    // strip beside the track they act on (streamdeck/screens/now-playing-screen.mts).
    const mainGrid: PageGrid = [
        [
            new VoiceTile(model, lva),
            // One key for several playlists: press to arm, turn the dynamic dial to
            // pick, press again to play. It claims the shared dial exactly as the
            // room keys do, so the same knob that dims the lights picks a playlist.
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
                // A turning fan needs a moving angle; the tile accumulates the elapsed
                // time it has been running and hands it here as `phase`, so one full
                // turn is 1200ms of real time however often the key repaints.
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
                // A bar under the glyph carries how far the blind is still shut, so
                // the key tracks the dial rather than only reading open or closed. A
                // cover reporting no position falls back to fully raised or down.
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


    // A glanceable page: the top row changes nothing when pressed. The two audio
    // route keys share the bottom row.
    const infoGrid: PageGrid = [
        [
            key('MIC', '#7f0000', voice('mute_toggle')),
            new TemperatureTile(ha, {label: 'OFFICE', entity: HA.temperature}),
            null,
            // Panel brightness sits on the quiet page: a setting you go looking for
            // rather than reach for, like the stop key below it.
            new BrightnessTile(model),
        ],
        [
            key('STOP', '#b71c1c', voice('stop')),
            key('AUX', '#4a148c', route('aux', 'toggle')),
            key('USB', '#0d47a1', route('usb', 'toggle')),
            null,
        ],
    ]

    // Six sockets for another computer to fill over the remote-tile server
    // (remote/server.mts): a client pushes a face onto a slot and gets the presses
    // back. The page exists only when the feature is configured — unlike the Home
    // Assistant keys there is no unknown state to show, just slots nothing could
    // ever fill.
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

    // Four dials, left to right. Volume and media are fixed, because a knob you
    // have to look at before turning is a knob you stop using; the third pages the
    // key grid, taking over the job the bottom-corner keys used to do; the fourth
    // follows the last room key you pressed. Each carries its own readout, so the
    // display stays correct however these are ordered. That readout is shown
    // across the whole touch strip while the dial is being turned — see below.
    const dials: Dial[] = [
        new VolumeDial(audio, model),
        new MediaDial(ha, lva, model, {player: HA.player}),
        // Turning it moves between pages; it reads out the page you land on. The
        // renderer hands it its paging once it exists (streamdeck/dials/page-dial.mts).
        new PageDial(),
        dynamic,
    ]

    // The touch strip is one display, not four dial labels: it rests on what is
    // playing, hands itself to a dial while one is being turned, and to a
    // notification pushed from Home Assistant while one is live. Its resting face
    // is the now-playing strip while a track is playing or paused, and the idle
    // clock once the player is stopped — the strip shows the first that applies.
    const strip = new TouchStrip({
        resting: [
            new NowPlayingScreen(ha, clock, lva, model, {player: HA.player}),
            new IdleScreen(ha, clock, {weatherEntityId: HA.weather}),
        ],
        dials,
        clock,
        ...(notifications ? {notifications} : {}),
    })

    // Claiming the dial also puts it on the strip, so pressing LIGHTS shows the
    // brightness you are about to turn before you turn anything.
    dynamic.revealOn(() => strip.showDial(dials.indexOf(dynamic)))

    return {pages, dials, strip}
}
