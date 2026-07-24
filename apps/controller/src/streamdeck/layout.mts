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


import {isEntityOn, numericAttribute} from '../home-assistant/entity.mjs'
import {type Binding, createBindings, type TileServices} from './bindings.mjs'
import type {Dial} from './dials/dial.mjs'
import {DynamicDial} from './dials/dynamic-dial.mjs'
import {MediaDial} from './dials/media-dial.mjs'
import {PageDial} from './dials/page-dial.mjs'
import {VolumeDial} from './dials/volume-dial.mjs'
import type {StreamDeckLayout, StreamDeckPage} from './grid.mjs'
import {NowPlayingScreen} from './screens/now-playing-screen.mjs'
import {TouchStrip} from './strip.mjs'
import {ActionTile} from './tiles/action-tile.mjs'
import {BrightnessTile} from './tiles/brightness-tile.mjs'
import {ClockTile} from './tiles/clock-tile.mjs'
import {EntityToggleTile} from './tiles/entity-toggle-tile.mjs'
import {PlaylistTile} from './tiles/playlist-tile.mjs'
import {RemoteTile} from './tiles/remote-tile.mjs'
import {SceneTile} from './tiles/scene-tile.mjs'
import {ShuffleTile} from './tiles/shuffle-tile.mjs'
import {TemperatureTile} from './tiles/temperature-tile.mjs'
import {TimerTile} from './tiles/timer-tile.mjs'
import {WeatherTile} from './tiles/weather-tile.mjs'
import type {Tile} from './tile.mjs'
import {VoiceTile} from './tiles/voice-tile.mjs'

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
    player: 'media_player.office_amp',
    lights: 'light.office',
    fan: 'fan.office_ceiling',
    blinds: 'cover.office_blinds',
    /** A wake-on-LAN switch, so the key both starts the PC and reports it. */
    pc: 'switch.office_pc',
    timer: 'timer.office',
    /** Reads `on` while somebody is in the room; the panel sleeps when it clears. */
    presence: 'binary_sensor.office_presence',
    temperature: 'sensor.office_temperature',
    weather: 'weather.home',
    scenes: [
        {label: 'BRIGHT', entity: 'scene.office_bright', color: '#f9a825'},
        {label: 'WORK', entity: 'scene.office_work', color: '#0277bd'},
        {label: 'WARM', entity: 'scene.office_warm', color: '#bf360c'},
        {label: 'OFF', entity: 'scene.office_off', color: '#37474f'},
    ],
    /** The playlist the shortcut key starts. Take the id from Music Assistant. */
    playlist: {
        media_content_id: 'library://playlist/1',
        media_content_type: 'playlist',
    },
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
export function createLayout(services: TileServices): StreamDeckLayout {
    // `route` binds a key straight to one audio route: MAIN carries a dedicated
    // AUX and USB key, each toggling its own route independently.
    const {voice, route} = createBindings(services)
    const key = (label: string, color: string, binding: Binding): Tile =>
        new ActionTile(services, {label, color, binding})

    // The one dial with no fixed job. The lights, fan, and blinds keys below hand
    // it their entity as they are pressed, so a single knob dims, changes speed,
    // and opens without the deck needing a dial for each.
    const dynamic = new DynamicDial(services.model)

    // Each page is a fixed grid of eight named slots; an omitted slot renders
    // blank. Every tile keeps its grid position across pages, so adding a page
    // never reshuffles the keys already placed. A slot can hold any Tile: a plain
    // `key(...)` or a dynamic one that draws its own face from live state, such as
    // MediaTile, TimerTile, or WeatherTile. The third dial pages between them.
    const pages: StreamDeckPage[] = [
        {
            // Everything you reach for while music is playing or you are talking to
            // the house.
            name: 'MAIN',
            grid: {
                topLeft: new ClockTile(),
                topMidLeft: new WeatherTile(services, {entity: HA.weather}),
                topMidRight: new EntityToggleTile(services, {
                    label: 'PC',
                    entity: HA.pc,
                    icon: 'computer',
                    onColor: '#283593',
                    offColor: '#151a30',
                }),
                topRight: new TimerTile(services, {entity: HA.timer, duration: TIMER_DURATION}),

                bottomLeft: new VoiceTile(services),
                bottomMidLeft: new ShuffleTile(services, HA.player),
                bottomMidRight: new PlaylistTile(services, {
                    label: 'MELLOW',
                    player: HA.player,
                    media: HA.playlist,
                }),
                bottomRight: new PlaylistTile(services, {
                    label: 'ROCK',
                    player: HA.player,
                    media: HA.playlist,
                })
            },
        },
        {
            // The room itself: lights, the things that move, and the desk PC.
            name: 'ROOM',
            grid: {
                topLeft: new SceneTile(services, {scenes: HA.scenes}),
                // The three keys that also drive the dynamic dial: pressing one flips
                // it and hands the dial its entity, so the knob is always pointed at
                // whatever you last touched.
                topMidLeft: new EntityToggleTile(services, {
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
                topMidRight: new EntityToggleTile(services, {
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
                bottomMidRight: new EntityToggleTile(services, {
                    label: 'LIGHTS',
                    entity: HA.lights,
                    icon: 'bulb',
                    onColor: '#6b5200',
                    offColor: '#1e1a0c',
                    dial: dynamic,
                }),
            },
        },
        {
            // A glanceable page: the top row changes nothing when pressed.
            name: 'INFO',
            grid: {
                topMidLeft: new TemperatureTile(services, {label: 'OFFICE', entity: HA.temperature}),
                // Panel brightness sits on the quiet page: a setting you go looking for
                // rather than reach for, like the stop key below it.
                topRight: new BrightnessTile(services),
                bottomLeft: key('STOP', '#b71c1c', voice('stop')),
                topLeft: key('MIC', '#7f0000', voice('mute_toggle')),

                // The playlist shortcut lives here rather than on MAIN so the two audio
                // route keys can share the bottom row there.

                bottomMidLeft: key('AUX', '#4a148c', route('aux', 'toggle')),
                bottomMidRight: key('USB', '#0d47a1', route('usb', 'toggle')),
            },
        },
        // Six sockets for another computer to fill over the remote-tile server
        // (remote/server.mts): a client pushes a face onto a slot and gets the
        // presses back. The page exists only when the feature is configured —
        // unlike the Home Assistant keys there is no unknown state to show, just
        // slots nothing could ever fill.
        ...(services.remote
            ? [{
                name: 'REMOTE',
                grid: {
                    topLeft: new RemoteTile(services, {slot: 0}),
                    topMidLeft: new RemoteTile(services, {slot: 1}),
                    topMidRight: new RemoteTile(services, {slot: 2}),
                    topRight: new RemoteTile(services, {slot: 3}),
                    bottomMidLeft: new RemoteTile(services, {slot: 4}),
                    bottomMidRight: new RemoteTile(services, {slot: 5}),
                },
            }]
            : []),
    ]

    // Four dials, left to right. Volume and media are fixed, because a knob you
    // have to look at before turning is a knob you stop using; the third pages the
    // key grid, taking over the job the bottom-corner keys used to do; the fourth
    // follows the last room key you pressed. Each carries its own readout, so the
    // display stays correct however these are ordered. That readout is shown
    // across the whole touch strip while the dial is being turned — see below.
    const dials: Dial[] = [
        new VolumeDial(services),
        new MediaDial(services, {player: HA.player}),
        // Turning it moves between pages; it reads out the page you land on. The
        // renderer hands it its paging once it exists (streamdeck/dials/page-dial.mts).
        new PageDial(),
        dynamic,
    ]

    // The touch strip is one display, not four dial labels: it rests on what is
    // playing, hands itself to a dial while one is being turned, and to a
    // notification pushed from Home Assistant while one is live.
    const strip = new TouchStrip({
        resting: new NowPlayingScreen(services, {player: HA.player}),
        dials,
        clock: services.clock,
        ...(services.notifications ? {notifications: services.notifications} : {}),
    })

    // Claiming the dial also puts it on the strip, so pressing LIGHTS shows the
    // brightness you are about to turn before you turn anything.
    dynamic.revealOn(() => strip.showDial(dials.indexOf(dynamic)))

    return {pages, dials, strip}
}
