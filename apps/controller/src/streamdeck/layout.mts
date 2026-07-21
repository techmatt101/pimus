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
// Every key is a Tile (streamdeck/tile.mts) that renders its own face: a plain
// `key(...)` for a fixed button, or a dynamic tile such as `MediaTile`. The
// dials keep their bindings on every page, so volume and the aux/usb routes are
// always one turn away whichever page is showing.

import type { RouteActionName, VolumeActionName } from '../actions/catalog.mjs'
import type { StreamDeckPage, StreamDeckLayout } from './grid.mjs'
import { ActionTile, MediaTile, Tile } from './tile.mjs'
import type { Action, StreamDeckDial } from '../types.mjs'

// Tile and action builders. `key` places a fixed labelled tile; its feedback
// (mute, listen, and route colour changes) comes from the action's catalog
// indicator. Voice commands are a free string because the controller forwards
// anything to LVA (see actions/catalog.mts); routes and volume are checked
// against the catalog at compile time. To post to Home Assistant, pass
// `{ type: 'webhook', id: 'my_automation' }` as the action.
const key = (label: string, color: string, action: Action): Tile => new ActionTile({ label, color, action })
const voice = (command: string): Action => ({ type: 'lva', command })
const volume = (command: VolumeActionName): Action => ({ type: 'audio', command })
const route = (source: string, command: RouteActionName): Action => ({ type: 'audio', source, command })
const NONE: Action = { type: 'noop' }

/** Panel brightness, 0 to 100. */
const BRIGHTNESS = 40

// Each page is a fixed grid. The two bottom corners are page navigation, so a
// page fills the six named slots between them; an omitted slot renders blank.
// Every tile keeps its grid position whether or not paging is active, so adding
// a page never reshuffles the keys already placed. A slot can hold any Tile: a
// plain `key(...)` or a dynamic one such as `MediaTile`, which is a single
// play/pause button that draws its own icon and colour from the playback state.
const PAGES: StreamDeckPage[] = [
  {
    name: 'MAIN',
    grid: {
      topLeft: key('VOICE', '#006064', voice('start_listening')),
      topMidLeft: key('MIC', '#7f0000', voice('mute_toggle')),
      topMidRight: new MediaTile(),
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

// Four dials, left to right. A dial's readout follows the actions bound to it,
// so the display stays correct however these are ordered.
const DIALS: StreamDeckDial[] = [
  { label: 'VOLUME', left: volume('down'), right: volume('up'), press: volume('mute') },
  { label: 'AUX', left: route('aux', 'off'), right: route('aux', 'on'), press: route('aux', 'toggle') },
  { label: 'USB', left: route('usb', 'off'), right: route('usb', 'on'), press: route('usb', 'toggle') },
  { label: 'VOICE', left: NONE, right: NONE, press: voice('start_listening') },
]

export const STREAMDECK_LAYOUT: StreamDeckLayout = {
  brightness: BRIGHTNESS,
  pages: PAGES,
  dials: DIALS,
}
