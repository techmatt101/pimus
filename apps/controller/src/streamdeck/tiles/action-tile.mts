// The default key: a fixed label and colour that runs one binding. This is the
// tile to reach for unless a key needs behaviour or rendering the catalog
// indicator cannot express — then write a new Tile class in this folder.

import { indicatorFor } from '../../actions/catalog.mjs'
import type { Binding } from '../bindings.mjs'
import { labelTile, type Tile, type TileContext } from './tile.mjs'
import type { Action, Bitmap } from '../../types.mjs'

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
 * catalog indicator. An action with no indicator keeps its configured label and
 * colour; the mute, media, listen, and route indicators drive their own.
 */
export function actionAppearance(config: ActionTileConfig, context: TileContext): KeyAppearance {
  const action = config.binding?.action
  const indicator = indicatorFor(action)
  if (!indicator) return { label: config.label, background: config.color }

  const active = indicator.isActive({ state: context.state, audio: context.audio, source: action?.source })
  return {
    label: indicator.label ? indicator.label(config.label, active) : config.label,
    background: active ? indicator.activeColor : config.color,
  }
}

/**
 * A fixed labelled key that runs one binding, with any active-state feedback
 * coming from the bound action's catalog indicator.
 */
export class ActionTile implements Tile {
  constructor(private readonly config: ActionTileConfig) {}

  action(): Action | undefined {
    return this.config.binding?.action
  }

  press(): unknown {
    return this.config.binding?.run()
  }

  render(context: TileContext): Bitmap {
    const { label, background } = actionAppearance(this.config, context)
    return labelTile(background, label)
  }
}
