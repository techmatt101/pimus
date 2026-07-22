// One key that cycles what the amplifier is listening to, instead of one key
// per audio route. Pressing it moves to the next mode and reconciles every
// route the tile owns — enabling the mode's route and disabling the others — so
// the routes can never end up both on, which separate AUX and USB keys allowed.
//
// The current mode is read back from the audio manager rather than remembered
// here, so a route changed by the dials or by the manager's own reconciliation
// still shows correctly on this key.

import { fittingSize, type Surface } from '../surface.mjs'
import { drawBackground, drawCaption, drawDots, FACE_CENTER, type Tile, type TileContext } from './tile.mjs'
import type { IconName } from '../icon-set.mjs'
import type { TileServices } from '../bindings.mjs'
import type { AudioState } from '../../types.mjs'

/**
 * One selectable input. A mode with no `source` is "every route off" — the
 * network player, which reaches the amplifier through its own sink rather than
 * through a loopback the manager switches.
 */
export interface AudioMode {
  label: string
  color: string
  /** The glyph for the input, so the key reads without being read. */
  icon?: IconName
  /** The audio manager route this mode enables, if any. */
  source?: string
}

export interface AudioModeTileConfig {
  modes: readonly AudioMode[]
  /** Caption under the mode name. */
  label?: string
}

export class AudioModeTile implements Tile {
  private readonly setSource: TileServices['setSource']
  private readonly modes: readonly AudioMode[]
  private readonly label: string

  constructor(services: TileServices, { modes, label = 'MODE' }: AudioModeTileConfig) {
    if (modes.length === 0) throw new Error('an audio mode tile needs at least one mode')
    this.setSource = services.setSource
    this.modes = modes
    this.label = label
  }

  /**
   * The mode showing now: the first whose route the manager reports on, else
   * the sourceless mode. With every route off and no sourceless mode declared,
   * the first mode is shown so the key always names something.
   */
  private currentIndex(audio: AudioState): number {
    const active = this.modes.findIndex((mode) => mode.source && audio.sources[mode.source])
    if (active >= 0) return active
    const passive = this.modes.findIndex((mode) => !mode.source)
    return passive >= 0 ? passive : 0
  }

  press({ audio }: TileContext): unknown {
    const next = (this.currentIndex(audio) + 1) % this.modes.length
    const target = this.modes[next]
    // Send the whole set rather than just the change: the manager is
    // authoritative and idempotent, so this also repairs a state where a
    // previous failure left two routes on.
    for (const mode of this.modes) {
      if (mode.source) this.setSource(mode.source, mode === target ? 'on' : 'off')
    }
    return undefined
  }

  draw(surface: Surface, { audio }: TileContext): void {
    const index = this.currentIndex(audio)
    const mode = this.modes[index]
    const name = mode?.label ?? '?'
    const x = surface.width / 2
    drawBackground(surface, mode?.color ?? '#263238')

    if (mode?.icon) {
      surface.icon(mode.icon, { x, y: 30, size: 34, color: '#ffffff' })
      surface.text(name, { x, y: FACE_CENTER + 16, size: fittingSize(name, [30, 24, 20], 112) })
    } else {
      surface.text(name, { x, y: FACE_CENTER, size: fittingSize(name, [36, 30, 24], 112) })
    }

    // A dot per mode, the current one filled, so you can see how many presses
    // it takes to get back around without cycling through to find out.
    drawDots(surface, this.modes.length, index, 78, '#ffffff')
    drawCaption(surface, this.label)
  }
}
