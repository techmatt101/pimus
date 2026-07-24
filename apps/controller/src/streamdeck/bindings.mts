// The executable side of the control surface. A Binding pairs a declarative
// catalog action with the behaviour that runs it, closed over the controller
// services injected by the layout factory (streamdeck/layout.mts). Tiles
// (streamdeck/tiles/) and dials both run bindings; the declarative half feeds
// catalog indicators, dial readouts, and layout validation.

import {
  runHaCommand,
  runVoiceCommand,
  type HaActionName,
  type RouteActionName,
  type VolumeActionName,
} from '../actions/catalog.mjs'
import type { ControlModel } from '../state.mjs'
import type { Action, HomeAssistantService, LvaSender, NotificationFeed, RemoteTileFeed } from '../types.mjs'

/**
 * The controller services injected into tiles and dial bindings. Depending on
 * this narrow surface instead of the concrete clients keeps tiles free of
 * device lifecycles and lets tests inject plain recording objects.
 */
export interface TileServices {
  /** The observable control-surface model; mutate its state, then notify. */
  model: ControlModel
  /**
   * Wall-clock milliseconds, injected so a tile that shows the time of day or
   * counts down to an instant (the clock, the timer) can be pinned in a test.
   * A tile's decorative animation uses the `deltaTime` its `draw` is handed
   * instead; this is only for reading true elapsed wall-clock time.
   */
  clock: () => number
  lva: LvaSender
  /** Applies on/off/toggle to a named audio route via the audio manager socket. */
  setSource(name: string, command: string): unknown
  /** Applies up/down/mute to the PipeWire default sink. */
  setVolume(command: string): unknown
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
   * builds the REMOTE page when the feature is configured, because a page of
   * sockets nothing can ever fill is noise rather than unknown state.
   */
  remote?: RemoteTileFeed
}

/**
 * One executable control binding: the declarative action it stands for — kept
 * for catalog indicators, dial readouts, and layout validation — paired with
 * the behaviour that closes over the injected services.
 */
export interface Binding {
  action: Action
  run(): unknown
}

/**
 * Binding builders closed over the injected services. The layout factory uses
 * these to give every key and dial its behaviour. Route, volume, and Home
 * Assistant commands are checked against the catalog at compile time; voice
 * commands stay a free string because anything uncatalogued is forwarded to LVA
 * verbatim.
 */
export function createBindings(services: TileServices) {
  const voiceContext = () => ({
    state: services.model.state,
    lva: services.lva,
    onStateChange: () => services.model.notify(),
  })
  return {
    voice: (command: string): Binding => ({
      action: { type: 'lva', command },
      run: () => runVoiceCommand(command, voiceContext()),
    }),
    volume: (command: VolumeActionName): Binding => ({
      action: { type: 'audio', command },
      run: () => services.setVolume(command),
    }),
    route: (source: string, command: RouteActionName): Binding => ({
      action: { type: 'audio', source, command },
      run: () => services.setSource(source, command),
    }),
    ha: (command: HaActionName, entity: string, data?: Record<string, unknown>): Binding => ({
      action: { type: 'ha', command, entity, ...(data ? { data } : {}) },
      run: () => runHaCommand(command, { ha: services.ha, entity, data }),
    }),
    /** An explicitly blank binding, for a dial direction you do not want bound. */
    none: (): Binding => ({ action: { type: 'noop' }, run: () => {} }),
  }
}
