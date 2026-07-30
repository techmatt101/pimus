import {indicatorFor} from '../../actions/catalog.mjs'
import type {Binding} from '../bindings.mjs'
import {drawBackground, drawCaption, drawLabelFace, type Tile} from '../tile.mjs'
import type {Surface} from '../surface.mjs'
import type {ControlModel} from '../../state.mjs'
import type {Action, AudioState, ControlState} from '../../types.mjs'

export interface KeyAppearance {
    label: string
    background: string
    /** False when the hardware has no such thing to control; the key is inert. */
    available: boolean
}

export interface ActionTileConfig {
    label: string
    color: string
    binding?: Binding
}

// The palette a key wears when what it controls is not on this unit, matching
// the offline face VoiceTile draws for an unreachable pipeline.
const UNAVAILABLE_BACKGROUND = '#131a1d'
const UNAVAILABLE_LABEL = '#546e7a'

export function actionAppearance(
    config: ActionTileConfig,
    state: ControlState,
    audio: AudioState,
): KeyAppearance {
    const action = config.binding?.action
    const indicator = indicatorFor(action)
    if (!indicator) return {label: config.label, background: config.color, available: true}

    const context = {state, audio, source: action?.source}
    if (indicator.isAvailable && !indicator.isAvailable(context)) {
        return {label: config.label, background: UNAVAILABLE_BACKGROUND, available: false}
    }
    const active = indicator.isActive(context)
    return {
        label: indicator.label ? indicator.label(config.label, active) : config.label,
        background: active ? indicator.activeColor : config.color,
        available: true,
    }
}

/**
 * A fixed labelled key that runs one binding, with active-state feedback from
 * the bound action's catalog indicator.
 */
export class ActionTile implements Tile {
    readonly #model: ControlModel
    readonly #config: ActionTileConfig

    constructor(model: ControlModel, config: ActionTileConfig) {
        this.#model = model
        this.#config = config
    }

    action(): Action | undefined {
        return this.#config.binding?.action
    }

    press(): void {
        // Not merely cosmetic: setSource writes the name into the cached route
        // list, so a pressable unavailable key would light itself up.
        if (!this.#appearance().available) return
        this.#config.binding?.run()
    }

    draw(surface: Surface): void {
        const {label, background, available} = this.#appearance()
        if (!available) {
            drawBackground(surface, background)
            drawCaption(surface, label, UNAVAILABLE_LABEL)
            return
        }
        drawLabelFace(surface, background, label)
    }

    #appearance(): KeyAppearance {
        return actionAppearance(this.#config, this.#model.state, this.#model.audio)
    }
}
