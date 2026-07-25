import {requireEntity} from '../../actions/catalog.mjs'
import {ArmedControl} from '../armed-control.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import {SelectionDial, type SelectionOption} from '../selection-dial.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, drawDots, type Tile, type TileHost} from '../tile.mjs'
import type {HomeAssistantService} from '../../types.mjs'

export interface SceneChoice extends SelectionOption {
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
 * Press to arm: the shared dial steps through the scenes. Press again — the key
 * or the knob — to apply the one showing. Scenes have no state to read back, so
 * the key remembers which it last applied and stays dim until the first apply.
 */
export class SceneTile implements Tile {
    readonly #dial: DynamicDial
    readonly #scenes: readonly SceneChoice[]
    readonly #label: string
    readonly #bindings: readonly Binding[]
    readonly #selection: SelectionDial<SceneChoice>
    readonly #armed: ArmedControl
    #applied = -1
    #host: TileHost | null = null

    constructor(ha: HomeAssistantService, dial: DynamicDial, {scenes, label = 'SCENE'}: SceneTileConfig) {
        if (scenes.length === 0) throw new Error('a scene tile needs at least one scene')
        this.#dial = dial
        this.#scenes = scenes
        this.#label = label
        // Built up front so every entity id is checked while the layout is built.
        this.#bindings = scenes.map((scene) => haBinding(ha, 'activate', requireEntity(scene.entity, `${scene.label} scene`)))
        this.#selection = new SelectionDial(label, scenes, {
            onConfirm: () => this.#confirm(),
            onChange: () => this.#host?.invalidate(),
        })
        this.#armed = new ArmedControl(dial, this.#selection, () => this.#confirm())
    }

    press(): void {
        // Start the picker where it left off, so turning continues from the
        // scene now applied rather than jumping back to the first.
        if (!this.#armed.armed) this.#selection.index = Math.max(0, this.#applied)
        this.#armed.press()
    }

    holdsDial(): boolean {
        return this.#armed.armed
    }

    #confirm(): void {
        const index = this.#selection.index
        this.#dial.release()
        this.#applied = index
        this.#bindings[index]?.run()
    }

    mount(host: TileHost): void {
        this.#host = host
    }

    unmount(): void {
        this.#host = null
        this.#armed.release()
    }

    draw(surface: Surface): void {
        const active = this.#armed.armed
        const showing = active ? this.#selection.index : Math.max(0, this.#applied)
        const scene = this.#scenes[showing]
        const name = scene?.label ?? '?'
        const lit = active || this.#applied >= 0
        const x = surface.width / 2
        drawBackground(surface, lit ? scene?.color ?? '#5d4037' : RESTING_COLOR)

        drawIcon(surface, 'bulb', {x, y: 24, size: 34, color: lit ? '#ffe082' : '#6d5a34'})
        drawText(surface, name, {x, y: 58, size: fittingSize(name, [30, 26, 22], 112)})

        drawDots(surface, this.#scenes.length, showing, 82, lit ? '#ffffff' : '#6d6d6d')
        drawCaption(surface, this.#label)

        if (active) drawActiveGlow(surface)
    }
}
