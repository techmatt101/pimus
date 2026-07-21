// The ReSpeaker LED ring without the USB. ReSpeakerController still decides
// which appearance each voice state gets and still de-duplicates identical
// writes; this only records the appearance it settled on so the browser can
// draw the ring.

import type { PlaygroundBus } from './bus.mjs'
import type { LedDevice, LedStateSpec } from '../../controller/src/types.mjs'

export interface LedAppearance extends LedStateSpec {
  brightness: number
  speed: number
}

export class FakeLedRing implements LedDevice {
  appearance: LedAppearance | null = null

  constructor(private readonly bus: PlaygroundBus) {}

  async apply(spec: LedStateSpec, brightness: number, speed: number): Promise<void> {
    this.appearance = { ...spec, brightness, speed }
    this.bus.log('led', 'out', `ring ${spec.effect ?? 'off'} ${spec.color ?? ''}`.trim(), `brightness ${brightness}`)
  }
}
