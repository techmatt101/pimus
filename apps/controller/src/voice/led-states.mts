// Which LED appearance each voice state shows. This is compiled in, exactly
// as the deck layout is (streamdeck/layout.mts): restyling the ring is an
// edit here and a redeploy, not an inventory change. Only the
// respeaker_led_enabled flag and the room's brightness live in Ansible.
//
// The keys are Linux Voice Assistant event names, plus the controller's own
// muted and disconnected states; respeaker.mts treats any event with an entry
// here as a state to show, so adding a row is all a new event needs.

import { Leds } from './led-appearance.mjs'
import type { LedAppearance } from './led-appearance.mjs'

export const VOICE_LED_STATES: ReadonlyMap<string, LedAppearance> = new Map(Object.entries({
  idle: Leds.direction('#102030', '#00bcd4'),
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
