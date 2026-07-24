import {requireEntity} from '../../actions/catalog.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawBackground, drawCaption, drawDots, type Tile} from '../tile.mjs'
import type {HomeAssistantService} from '../../types.mjs'

export interface SceneChoice {
    label: string
    entity: string
    color?: string
}

export interface SceneTileConfig {
    scenes: readonly SceneChoice[]
    label?: string
}

const RESTING_COLOR = '#1c1a10'

/**
 * Steps through a short list of scenes. Scenes have no state to read back —
 * activating one leaves no trace on the scene entity — so the key remembers
 * which it last applied and stays dim until the first press.
 */
export class SceneTile implements Tile {
    readonly #bindings: readonly Binding[]
    readonly #scenes: readonly SceneChoice[]
    readonly #label: string
    #applied = -1

    constructor(ha: HomeAssistantService, {scenes, label = 'SCENE'}: SceneTileConfig) {
        if (scenes.length === 0) throw new Error('a scene tile needs at least one scene')
        this.#scenes = scenes
        this.#label = label
        // Built up front so every entity id is checked while the layout is built.
        this.#bindings = scenes.map((scene) => haBinding(ha, 'activate', requireEntity(scene.entity, `${scene.label} scene`)))
    }

    press(): void {
        this.#applied = (this.#applied + 1) % this.#scenes.length
        this.#bindings[this.#applied]?.run()
    }

    draw(surface: Surface): void {
        const showing = this.#applied < 0 ? 0 : this.#applied
        const scene = this.#scenes[showing]
        const name = scene?.label ?? '?'
        const active = this.#applied >= 0
        const x = surface.width / 2
        drawBackground(surface, active ? scene?.color ?? '#5d4037' : RESTING_COLOR)

        drawIcon(surface, 'bulb', {x, y: 24, size: 34, color: active ? '#ffe082' : '#6d5a34'})
        drawText(surface, name, {x, y: 58, size: fittingSize(name, [30, 26, 22], 112)})

        drawDots(surface, this.#scenes.length, showing, 82, active ? '#ffffff' : '#6d6d6d')
        drawCaption(surface, this.#label)
    }
}
