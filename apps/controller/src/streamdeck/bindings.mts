// The executable side of the control surface. A Binding pairs a declarative
// catalog action with the behaviour that runs it, closed over just the one
// domain service that behaviour needs — the Home Assistant service, the voice
// transport, or the amplifier's audio controls — rather than a bag of every
// controller service. Tiles (streamdeck/tiles/) and dials both run bindings; the
// declarative half feeds catalog indicators, dial readouts, and layout validation.

import {
    type HaActionName,
    type RouteActionName,
    runHaCommand,
    runVoiceCommand,
    type VolumeActionName,
} from '../actions/catalog.mjs'
import type {ControlModel} from '../state.mjs'
import type {Action, AudioControls, HomeAssistantService, LvaSender} from '../types.mjs'

/**
 * One executable control binding: the declarative action it stands for — kept
 * for catalog indicators, dial readouts, and layout validation — paired with
 * the behaviour that closes over the service it needs.
 */
export interface Binding {
    action: Action

    run(): unknown
}

/**
 * A Home Assistant binding from just the Home Assistant service. A tile that
 * calls Home Assistant depends on this and `HomeAssistantService` rather than a
 * bag of every service, so its dependencies say what it actually touches.
 */
export function haBinding(
    ha: HomeAssistantService,
    command: HaActionName,
    entity: string,
    data?: Record<string, unknown>,
): Binding {
    return {
        action: {type: 'ha', command, entity, ...(data ? {data} : {})},
        run: () => runHaCommand(command, {ha, entity, data}),
    }
}

/**
 * A voice binding from the voice transport and the control model. It reads state
 * from the model and notifies it after running, so the display follows a command
 * the deck itself sent. A voice command is a free string because anything
 * uncatalogued is forwarded to LVA verbatim (see actions/catalog.mts).
 */
export function voiceBinding(lva: LvaSender, model: ControlModel, command: string): Binding {
    return {
        action: {type: 'lva', command},
        run: () => runVoiceCommand(command, {
            state: model.state,
            lva,
            onStateChange: () => model.notify(),
        }),
    }
}

/** A master-volume binding from the amplifier's audio controls. */
export function volumeBinding(audio: AudioControls, command: VolumeActionName): Binding {
    return {
        action: {type: 'audio', command},
        run: () => audio.setVolume(command),
    }
}

/** An audio-route binding from the amplifier's audio controls. */
export function routeBinding(audio: AudioControls, source: string, command: RouteActionName): Binding {
    return {
        action: {type: 'audio', source, command},
        run: () => audio.setSource(source, command),
    }
}
