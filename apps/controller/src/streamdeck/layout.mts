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
// The physical panel has 8 keys, 4 dials, and a touch strip above the dials.
// Each dial reacts to three inputs: `left` (counter-clockwise), `right`
// (clockwise), and `press` (also fired by tapping the strip above it). See
// docs/controls.md for every action and the key/dial feedback each produces.

import type { RouteActionName, VolumeActionName } from '../actions/catalog.mjs'
import type { Action, StreamDeckDial, StreamDeckKey, StreamDeckLayout } from '../types.mjs'

// Action builders. They keep the layout terse and, for routes and volume, catch
// a mistyped command at compile time. Voice commands are a free string because
// the controller forwards anything to LVA (see actions/catalog.mts). To post to
// Home Assistant, bind `{ type: 'webhook', id: 'my_automation' }` directly.
const voice = (command: string): Action => ({ type: 'lva', command })
const volume = (command: VolumeActionName): Action => ({ type: 'audio', command })
const route = (source: string, command: RouteActionName): Action => ({ type: 'audio', source, command })
const NONE: Action = { type: 'noop' }

/** Panel brightness, 0 to 100. */
const BRIGHTNESS = 40

// Eight key slots, left to right, top row then bottom. Fewer than eight is fine;
// the unused slots render blank.
const KEYS: StreamDeckKey[] = [
  { label: 'VOICE', color: '#006064', action: voice('start_listening') },
  { label: 'MIC', color: '#7f0000', action: voice('mute_toggle') },
  { label: 'AUX', color: '#4a148c', action: route('aux', 'toggle') },
  { label: 'USB', color: '#0d47a1', action: route('usb', 'toggle') },
  { label: 'PLAY', color: '#1b5e20', action: voice('media_toggle') },
  { label: 'STOP', color: '#b71c1c', action: voice('stop') },
  { label: 'TIMER', color: '#e65100', action: voice('stop_timer_ringing') },
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
  keys: KEYS,
  dials: DIALS,
}
