// Keys are Linux Voice Assistant event names, plus the controller's own
// starting, muted, and disconnected states; respeaker.mts treats any event with
// an entry here as a state to show, so adding a row is all a new event needs.

import type {LedAppearance} from './led-appearance.mjs'
import {Leds} from './led-appearance.mjs'

export const VOICE_LED_STATES: ReadonlyMap<string, LedAppearance> = new Map(Object.entries({
    idle: Leds.off(),
    // The ring lights long before the rest of the stack is up, so boot gets its
    // own amber spinner rather than borrowing the red "disconnected" warning.
    starting: Leds.spin('#ffab00'),
    wake_word_detected: Leds.pulse('#00bcd4'),
    listening: Leds.direction('#001018', '#00e5ff'),
    thinking: Leds.spin('#7c4dff'),
    tts_speaking: Leds.pulse('#00c853'),
    media_player_playing: Leds.solid('#1565c0'),
    timer_ticking: Leds.solid('#ffab00'),
    timer_ringing: Leds.blink('#ff6d00'),
    muted: Leds.solid('#d50000'),
    disconnected: Leds.pulse('#d50000'),
    pipeline_error: Leds.blink('#ff1744'),
}))
