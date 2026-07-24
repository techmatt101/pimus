// The default key: a fixed label and colour that runs one binding. This is the
// tile to reach for unless a key needs behaviour or rendering the catalog
// indicator cannot express — then write a new Tile class in this folder.

import {indicatorFor} from '../../actions/catalog.mjs'
import type {Binding} from '../bindings.mjs'
import {drawLabelFace, type Tile} from '../tile.mjs'
import type {Surface} from '../surface.mjs'
import type {ControlModel} from '../../state.mjs'
import type {Action, AudioState, ControlState} from '../../types.mjs'

/** The computed face of a labelled key: its caption and background colour. */
export interface KeyAppearance {
    label: string
    background: string
}

export interface ActionTileConfig {
    label: string
    color: string
    binding?: Binding
}

/**
 * The appearance of a labelled key, derived entirely from its bound action's
 * catalog indicator against the live control state. An action with no indicator
 * keeps its configured label and colour; the mute, media, listen, and route
 * indicators drive their own.
 */
export function actionAppearance(
    config: ActionTileConfig,
    state: ControlState,
    audio: AudioState,
): KeyAppearance {
    const action = config.binding?.action
    const indicator = indicatorFor(action)
    if (!indicator) return {label: config.label, background: config.color}

    const active = indicator.isActive({state, audio, source: action?.source})
    return {
        label: indicator.label ? indicator.label(config.label, active) : config.label,
        background: active ? indicator.activeColor : config.color,
    }
}

/**
 * A fixed labelled key that runs one binding, with any active-state feedback
 * coming from the bound action's catalog indicator. It reads that state from the
 * injected model at draw time rather than being handed it.
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
        this.#config.binding?.run()
    }

    draw(surface: Surface): void {
        const {label, background} = actionAppearance(this.#config, this.#model.state, this.#model.audio)
        drawLabelFace(surface, background, label)
    }
}
