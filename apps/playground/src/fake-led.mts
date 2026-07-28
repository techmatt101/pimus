// The ReSpeaker LED ring without the USB. The controller's LedRenderer still
// decides which frame each animation produces and still de-duplicates identical
// writes; this only translates the frame it settled on into hex colours and
// streams it to the browser, so the ring is watched frame by frame rather than
// sampled with the rest of the state panel.

import type {LedSnapshot, PlaygroundBus} from './bus.mjs'
import type {LedDevice, LedFrame} from '../../controller/src/types.mjs'
import {LedEffect} from '../../controller/src/types.mjs'

const hex = (color: number): string => `#${(color & 0xFFFFFF).toString(16).padStart(6, '0')}`

export class FakeLedRing implements LedDevice {
    private lastLogged = ''

    constructor(private readonly bus: PlaygroundBus) {
    }

    async apply(frame: LedFrame): Promise<void> {
        const effect = (LedEffect[frame.effect] ?? 'off').toLowerCase()
        const snapshot: LedSnapshot = {
            effect,
            colors: frame.ring ? frame.ring.map(hex) : null,
            brightness: frame.brightness,
        }
        this.bus.ledFrame(snapshot)
        // Animated faces deliver a frame per tick; narrating each one would
        // drown the log, so only a change of effect is logged.
        const line = `ring ${effect}${frame.ring ? ` ${frame.ring.length} colours` : ''}`
        if (line === this.lastLogged) return
        this.lastLogged = line
        this.bus.log('led', 'out', line, `brightness ${frame.brightness}`)
    }
}
