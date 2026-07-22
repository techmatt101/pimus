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
// Keys are paged; dials are not. With more than one PAGE the two bottom-corner
// keys become previous/next navigation, and each page fills the six named grid
// slots between them:
//
//     [ topLeft ][ topMidLeft ][ topMidRight ][ topRight ]
//     [  PREV   ][ bottomLeft ][ bottomRight ][   NEXT   ]
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


import { isEntityOn, numericAttribute } from '../home-assistant/entity.mjs'
import { createBindings, type Binding, type TileServices } from './bindings.mjs'
import { ActionDial } from './dials/action-dial.mjs'
import type { Dial } from './dials/dial.mjs'
import { DynamicDial } from './dials/dynamic-dial.mjs'
import { MediaDial } from './dials/media-dial.mjs'
import { VolumeDial } from './dials/volume-dial.mjs'
import type { StreamDeckPage, StreamDeckLayout } from './grid.mjs'
import { NowPlayingScreen } from './screens/now-playing-screen.mjs'
import { TouchStrip } from './strip.mjs'
import { ActionTile } from './tiles/action-tile.mjs'
import { AudioModeTile } from './tiles/audio-mode-tile.mjs'
import { ClockTile } from './tiles/clock-tile.mjs'
import { EntityToggleTile } from './tiles/entity-toggle-tile.mjs'
import { MediaTile } from './tiles/media-tile.mjs'
import { PageTile } from './tiles/page-tile.mjs'
import { PlaylistTile } from './tiles/playlist-tile.mjs'
import { SceneTile } from './tiles/scene-tile.mjs'
import { ShuffleTile } from './tiles/shuffle-tile.mjs'
import { TemperatureTile } from './tiles/temperature-tile.mjs'
import { TimerTile } from './tiles/timer-tile.mjs'
import { WeatherTile } from './tiles/weather-tile.mjs'
import type { Tile } from './tiles/tile.mjs'
import { VoiceTile } from './tiles/voice-tile.mjs'

/** Panel brightness, 0 to 100. */
const BRIGHTNESS = 40

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
  temperature: 'sensor.office_temperature',
  weather: 'weather.home',
  scenes: [
    { label: 'BRIGHT', entity: 'scene.office_bright', color: '#f9a825' },
    { label: 'WORK', entity: 'scene.office_work', color: '#0277bd' },
    { label: 'WARM', entity: 'scene.office_warm', color: '#bf360c' },
    { label: 'OFF', entity: 'scene.office_off', color: '#37474f' },
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
 * Builds the layout with the controller's services injected, so every tile and
 * dial binding carries its behaviour with it. The `voice`, `volume`, `route`,
 * and `ha` builders close over those services; `key` places a fixed labelled
 * tile whose feedback (mute and route colour changes) comes from the bound
 * action's catalog indicator. Voice commands are a free string because anything
 * uncatalogued is forwarded to LVA verbatim (see actions/catalog.mts); routes,
 * volume, and Home Assistant commands are checked against the catalog at
 * compile time. To post to a Home Assistant webhook instead of calling a
 * service, bind `webhook('my_automation')` from the same builders.
 */
export function createLayout(services: TileServices): StreamDeckLayout {
  // `route` is still available for a key bound straight to one audio route; the
  // AudioModeTile below owns aux and usb together, so nothing here uses it.
  const { voice, none } = createBindings(services)
  const key = (label: string, color: string, binding: Binding): Tile =>
    new ActionTile({ label, color, binding })

  // The one dial with no fixed job. The lights, fan, and blinds keys below hand
  // it their entity as they are pressed, so a single knob dims, changes speed,
  // and opens without the deck needing a dial for each.
  const dynamic = new DynamicDial(services.model)

  // Each page is a fixed grid. The two bottom corners are page navigation, so a
  // page fills the six named slots between them; an omitted slot renders blank.
  // Every tile keeps its grid position whether or not paging is active, so
  // adding a page never reshuffles the keys already placed. A slot can hold any
  // Tile: a plain `key(...)` or a dynamic one that draws its own face from live
  // state, such as MediaTile, TimerTile, or WeatherTile.
  const pages: StreamDeckPage[] = [
    {
      // Everything you reach for while music is playing or you are talking to
      // the house.
      name: 'MAIN',
      grid: {
        topLeft: new VoiceTile(services),
        topMidLeft: key('MIC', '#7f0000', voice('mute_toggle')),
        topMidRight: new MediaTile(services),
        topRight: new ShuffleTile(services, HA.player),
        // One key cycles the input instead of one key per route, which is what
        // frees the two dials the transport and lights now use.
        bottomLeft: new AudioModeTile(services, {
          modes: [
            { label: 'STREAM', color: '#004d40' },
            { label: 'AUX', color: '#4a148c', source: 'aux' },
            { label: 'USB', color: '#0d47a1', source: 'usb' },
          ],
        }),
        bottomRight: new PlaylistTile(services, {
          label: 'FOCUS',
          player: HA.player,
          media: HA.playlist,
        }),
      },
    },
    {
      // The room itself: lights, the things that move, and the desk PC.
      name: 'ROOM',
      grid: {
        topLeft: new SceneTile(services, { scenes: HA.scenes }),
        // The three keys that also drive the dynamic dial: pressing one flips
        // it and hands the dial its entity, so the knob is always pointed at
        // whatever you last touched.
        topMidLeft: new EntityToggleTile(services, {
          label: 'FAN',
          entity: HA.fan,
          icon: 'fan',
          onColor: '#00695c',
          offColor: '#0d2320',
          // A turning fan needs a moving angle; deriving it from the repaint
          // instant keeps drawing pure while the tile drives the repaints.
          spin: (_entity, now) => (now % 1200) / 1200,
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
        topRight: new EntityToggleTile(services, {
          label: 'PC',
          entity: HA.pc,
          icon: 'computer',
          onColor: '#283593',
          offColor: '#151a30',
        }),
        bottomLeft: new TimerTile(services, { entity: HA.timer, duration: TIMER_DURATION }),
        bottomRight: new EntityToggleTile(services, {
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
        topLeft: new ClockTile(),
        topMidLeft: new TemperatureTile(services, { label: 'OFFICE', entity: HA.temperature }),
        topMidRight: new WeatherTile(services, { entity: HA.weather }),
        // The corners already navigate; this shows a page key can sit anywhere,
        // which a page that wanted its whole bottom row for tiles would need.
        topRight: new PageTile({ delta: 1 }),
        // The one thing here that does something. It sits on the quiet page
        // because it is the key you go looking for rather than reach for.
        bottomLeft: key('STOP', '#b71c1c', voice('stop')),
      },
    },
  ]

  // Four dials, left to right. The first three are fixed, because a knob you
  // have to look at before turning is a knob you stop using; the fourth is
  // deliberately not, and follows the last room key you pressed. Each carries
  // its own readout, so the display stays correct however these are ordered.
  // That readout is shown across the whole touch strip while the dial is being
  // turned — see the strip below.
  const dials: Dial[] = [
    new VolumeDial(services),
    new MediaDial(services, { player: HA.player }),
    // Held open rather than filled with something half-wanted. Bound to nothing
    // and saying so, rather than left to look like a dial that has stopped
    // responding.
    new ActionDial({ label: 'SPARE', left: none(), right: none(), press: none(), readout: 'NOT IN USE' }),
    dynamic,
  ]

  // The touch strip is one display, not four dial labels: it rests on what is
  // playing, hands itself to a dial while one is being turned, and to a
  // notification pushed from Home Assistant while one is live.
  const strip = new TouchStrip({
    resting: new NowPlayingScreen(services, { player: HA.player }),
    dials,
    ...(services.notifications ? { notifications: services.notifications } : {}),
  })

  // Claiming the dial also puts it on the strip, so pressing LIGHTS shows the
  // brightness you are about to turn before you turn anything.
  dynamic.revealOn(() => strip.showDial(dials.indexOf(dynamic)))

  return { brightness: BRIGHTNESS, pages, dials, strip }
}
