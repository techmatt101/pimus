// The Stream Deck+ layout: what every key and dial does, and how bright the
// panel sits. This is the file to edit when you want to change the controls.
//
// It is compiled into the controller, so a change ships with `make
// deploy-controller` (or `make provision`). In return the layout is
// type-checked: the `route`/`volume` builders only accept commands that exist
// in actions/catalog.mts, and a test rejects any key or dial the catalog does
// not understand before it can reach the device. Whether a deck is driven at
// all stays a deployment choice in `streamdeck_enabled` (ansible inventory);
// this file only describes the surface.
//
// The physical panel is a 4x2 key grid, 4 dials, and a touch strip above the
// dials. Each dial reacts to three inputs: `left` (counter-clockwise), `right`
// (clockwise), and `press` (also fired by tapping the strip above it). See
// docs/controls.md for every action and the key/dial feedback each produces.
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
// tile such as `MediaTile`. The dials keep their bindings on every page, so
// volume and the aux/usb routes are always one turn away whichever page is
// showing.

import { createBindings, type Binding, type TileServices } from './bindings.mjs'
import type { StreamDeckDial, StreamDeckPage, StreamDeckLayout } from './grid.mjs'
import { ActionTile } from './tiles/action-tile.mjs'
import { MediaTile } from './tiles/media-tile.mjs'
import type { Tile } from './tiles/tile.mjs'

/** Panel brightness, 0 to 100. */
const BRIGHTNESS = 40

/**
 * Builds the layout with the controller's services injected, so every tile and
 * dial binding carries its behaviour with it. The `voice`, `volume`, and
 * `route` builders close over those services; `key` places a fixed labelled
 * tile whose feedback (mute, listen, and route colour changes) comes from the
 * bound action's catalog indicator. Voice commands are a free string because
 * anything uncatalogued is forwarded to LVA verbatim (see actions/catalog.mts);
 * routes and volume are checked against the catalog at compile time. To post
 * to Home Assistant, bind `webhook('my_automation')` from the same builders.
 */
export function createLayout(services: TileServices): StreamDeckLayout {
  const { voice, volume, route, none } = createBindings(services)
  const key = (label: string, color: string, binding: Binding): Tile =>
    new ActionTile({ label, color, binding })

  // Each page is a fixed grid. The two bottom corners are page navigation, so a
  // page fills the six named slots between them; an omitted slot renders blank.
  // Every tile keeps its grid position whether or not paging is active, so
  // adding a page never reshuffles the keys already placed. A slot can hold any
  // Tile: a plain `key(...)` or a dynamic one such as `MediaTile`, which is a
  // single play/pause button that draws its own icon and colour from the
  // playback state.
  const pages: StreamDeckPage[] = [
    {
      name: 'MAIN',
      grid: {
        topLeft: key('VOICE', '#006064', voice('start_listening')),
        topMidLeft: key('MIC', '#7f0000', voice('mute_toggle')),
        topMidRight: new MediaTile(services),
        topRight: key('STOP', '#b71c1c', voice('stop')),
        bottomLeft: key('AUX', '#4a148c', route('aux', 'toggle')),
        bottomRight: key('USB', '#0d47a1', route('usb', 'toggle')),
      },
    },
    {
      name: 'MORE',
      grid: {
        topLeft: key('TIMER', '#e65100', voice('stop_timer_ringing')),
      },
    },
  ]

  // Four dials, left to right. A dial's readout follows the actions bound to
  // it, so the display stays correct however these are ordered.
  const dials: StreamDeckDial[] = [
    { label: 'VOLUME', left: volume('down'), right: volume('up'), press: volume('mute') },
    { label: 'AUX', left: route('aux', 'off'), right: route('aux', 'on'), press: route('aux', 'toggle') },
    { label: 'USB', left: route('usb', 'off'), right: route('usb', 'on'), press: route('usb', 'toggle') },
    { label: 'VOICE', left: none(), right: none(), press: voice('start_listening') },
  ]

  return { brightness: BRIGHTNESS, pages, dials }
}
