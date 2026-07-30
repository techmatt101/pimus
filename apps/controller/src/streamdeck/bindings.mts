import {
    type HaActionName,
    PANEL_ACTIONS,
    type PanelActionName,
    type RouteActionName,
    runHaCommand,
    runVoiceCommand,
    type VolumeActionName,
} from '../actions/catalog.mjs'
import type {ControlModel} from '../state.mjs'
import type {Action, AudioControls, HomeAssistantService, LvaSender, PowerControls} from '../types.mjs'

/**
 * One executable control binding: the declarative action it stands for — kept
 * for catalog indicators, dial readouts, and layout validation — paired with
 * the behaviour that closes over the one service it needs.
 */
export interface Binding {
    action: Action

    run(): unknown
}

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

export function voiceBinding(lva: LvaSender, model: ControlModel, command: string): Binding {
    return {
        action: {type: 'lva', command},
        run: () => runVoiceCommand(command, {state: model.state, lva}),
    }
}

export function volumeBinding(audio: AudioControls, command: VolumeActionName): Binding {
    return {
        action: {type: 'audio', command},
        run: () => audio.setVolume(command),
    }
}

export function routeBinding(audio: AudioControls, source: string, command: RouteActionName): Binding {
    return {
        action: {type: 'audio', source, command},
        run: () => audio.setSource(source, command),
    }
}

export function panelBinding(power: PowerControls, command: PanelActionName): Binding {
    return {
        action: {type: 'panel', command},
        run: () => PANEL_ACTIONS[command].run({power}),
    }
}
