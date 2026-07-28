// Keys are Linux Voice Assistant event names, plus the controller's own
// starting, muted, and disconnected states; respeaker.mts treats any event with
// an entry here as a state to show, so adding a row is all a new event needs.

import type {LedAnimation} from './leds/animation.mjs'
import {Blink} from './leds/blink.mjs'
import {Dark} from './leds/dark.mjs'
import {ListenWave} from './leds/listen-wave.mjs'
import {Pulse} from './leds/pulse.mjs'
import {SpeechPulse} from './leds/speech-pulse.mjs'
import {Spin} from './leds/spin.mjs'
import {Solid} from './leds/solid.mjs'

export const VOICE_LED_STATES: ReadonlyMap<string, LedAnimation> = new Map(Object.entries({
    idle: new Dark(),
    // The ring lights long before the rest of the stack is up, so boot gets its
    // own amber spinner rather than borrowing the red "disconnected" warning.
    starting: new Spin('#ffd500'),
    wake_word_detected: new Pulse('#00bcd4'),
    listening: new ListenWave('#001018', '#00e5ff'),
    thinking: new Spin('#7c4dff'),
    tts_speaking: new SpeechPulse('#ffffff'),
    timer_ticking: new Solid('#ffab00'),
    timer_ringing: new Blink('#ff6d00'),
    muted: new Solid('#d50000'),
    disconnected: new Pulse('#d50000'),
    pipeline_error: new Blink('#ff1744'),
}))
