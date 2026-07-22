// The ReSpeaker LED ring without the USB. The controller's LedRenderer still
// decides which frame each appearance produces and still de-duplicates
// identical writes; this only records the frame it settled on, translated back
// to names and hex colours so the browser can draw the ring.

import type { PlaygroundBus } from './bus.mjs'
import { LedEffect } from '../../controller/src/types.mjs'
import type { LedDevice, LedFrame } from '../../controller/src/types.mjs'

export interface LedSnapshot {
  effect: string
  color: string
  accent?: string
  colors?: string[]
  brightness: number
  speed: number
}

const hex = (color: number): string => `#${(color & 0xFFFFFF).toString(16).padStart(6, '0')}`

export class FakeLedRing implements LedDevice {
  appearance: LedSnapshot | null = null
  private lastLogged = ''

  constructor(private readonly bus: PlaygroundBus) {}

  async apply(frame: LedFrame): Promise<void> {
    const effect = (LedEffect[frame.effect] ?? 'off').toLowerCase()
    this.appearance = {
      effect,
      color: hex(frame.color),
      accent: frame.direction ? hex(frame.direction.highlight) : undefined,
      colors: frame.ring?.map(hex),
      brightness: frame.brightness,
      speed: frame.speed,
    }
    // Animated appearances deliver a frame per tick; narrating each rotation
    // step would drown the log, so only a change of effect is logged.
    const line = `ring ${effect} ${frame.ring ? `${frame.ring.length} colours` : this.appearance.color}`
    if (line === this.lastLogged) return
    this.lastLogged = line
    this.bus.log('led', 'out', line, `brightness ${frame.brightness}`)
  }
}
