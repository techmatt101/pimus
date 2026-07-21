// One key that steps through a short list of Home Assistant scenes. Scenes have
// no state to read back — activating one leaves no trace on the scene entity —
// so this key remembers which one it last applied and shows that, dimming the
// face until the first press so it never claims a scene is active when the room
// was set from somewhere else.

import { requireEntity } from '../../actions/catalog.mjs'
import { createBindings, type Binding, type TileServices } from '../bindings.mjs'
import { createImage, drawCircle, drawText } from '../bitmap.mjs'
import { bulbIcon } from '../icons.mjs'
import { drawCaption, type Tile } from './tile.mjs'
import type { Bitmap } from '../../types.mjs'

/** One scene in the cycle: what to call it and which entity to activate. */
export interface SceneChoice {
  label: string
  entity: string
  /** Background while this scene is the one last applied. */
  color?: string
}

export interface SceneTileConfig {
  scenes: readonly SceneChoice[]
  /** Caption under the scene name. */
  label?: string
}

/** Shown before any press, when no scene has been applied from this key. */
const RESTING_COLOR = '#1c1a10'

export class SceneTile implements Tile {
  private readonly bindings: readonly Binding[]
  private readonly scenes: readonly SceneChoice[]
  private readonly label: string
  // -1 means "nothing applied from this key yet".
  private applied = -1

  constructor(services: TileServices, { scenes, label = 'SCENE' }: SceneTileConfig) {
    if (scenes.length === 0) throw new Error('a scene tile needs at least one scene')
    const { ha } = createBindings(services)
    this.scenes = scenes
    this.label = label
    // Building every binding up front checks every entity id while the layout
    // is built, not only the one that happens to be selected.
    this.bindings = scenes.map((scene) => ha('activate', requireEntity(scene.entity, `${scene.label} scene`)))
  }

  press(): unknown {
    this.applied = (this.applied + 1) % this.scenes.length
    return this.bindings[this.applied]?.run()
  }

  render(): Bitmap {
    // Before the first press the first scene is previewed, so the key names
    // what pressing it will do rather than sitting blank.
    const showing = this.applied < 0 ? 0 : this.applied
    const scene = this.scenes[showing]
    const name = scene?.label ?? '?'
    const active = this.applied >= 0
    const face = createImage(120, 120, active ? scene?.color ?? '#5d4037' : RESTING_COLOR)

    // Stacked rather than side by side: a scene name is up to eight characters,
    // which leaves no room beside an icon on a 120px key.
    bulbIcon(face, 60, 26, active ? '#ffe082' : '#5d4c2e')
    drawText(face, name, 60, 60, name.length > 5 ? 2 : 3)

    const spacing = 14
    const left = 60 - ((this.scenes.length - 1) * spacing) / 2
    this.scenes.forEach((_, position) => {
      drawCircle(face, left + position * spacing, 82, 4, active ? '#ffffff' : '#6d6d6d', {
        filled: position === showing,
      })
    })

    drawCaption(face, this.label)
    return face
  }
}
