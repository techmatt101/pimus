# Architecture

Runtime logic is grouped by deployable component under `apps/`; each app owns
its `src/` and tests. Ansible only installs that code, renders configuration,
and manages operating-system services.

```text
                                      +--------------------------+
XVF3800 microphones --USB/PipeWire--->| Linux Voice Assistant    |--ESPHome API--> Home Assistant
                                      | local wake word + media  |
                                      +------------+-------------+
                                                   | peripheral WebSocket
                                      +------------+-------------+
                                      | Node hardware controller |
                                      +------+---------------+---+
                                             | USB           | HID
                                      XVF3800 LEDs       Stream Deck+

DAC2 ADC Pro aux --PipeWire loopback------------------------+
Computer --USB-C UAC2--+                                    |
                       +--> duckable background bus --------+--> HiFiBerry DAC --> AAmp60 --> speakers
Sendspin / MA ---------+                                    |
Linux Voice Assistant TTS/media --> voice bus --------------+
```

## Audio ownership

PipeWire and WirePlumber run in a persistent `smartamp` system-user session. The audio manager finds devices by
configurable regular expressions instead of unstable ALSA card numbers, makes HiFiBerry the default sink, publishes the
XVF3800's ASR channel as the mono default voice source, and creates monitor loopbacks for enabled input routes.

The XVF3800's USB capture is not a stereo microphone: the chip beamforms its four mics internally and presents two
independent DSP outputs — channel 0 is the Conference stream (post-processed for human listeners) and channel 1 is the
ASR stream (tuned for wake-word and speech recognition). Recording the device in mono would downmix the two, so the
audio manager loads a `module-remap-source` that lifts exactly the ASR channel (`smartamp_voice_capture_channel`,
default 1) into the `smartamp_voice_capture` source and makes that the default. Linux Voice Assistant records this one
channel; it must not be given a second channel, which it would forward to Home Assistant advertised as a far-end echo
reference for server-side AEC — on this device that second channel is the voice itself, not a reference.

The voice service waits for a fresh audio-manager status file containing both
devices. It then lets the audio library resolve PipeWire's selected defaults;
`default` is not passed as a literal hardware-device name.

Sendspin and the USB computer input feed a named background sink. Its monitor is bridged to HiFiBerry through one
gain-controlled loopback; Linux Voice Assistant and aux bypass it. The controller requests ducking on
wake/listen/think/TTS, announcement, and timer events by sending `set-duck` over the audio manager's control socket. The
manager holds the request against that connection, so background audio cannot remain quiet indefinitely: if the
controller stops unexpectedly the socket closes and the duck is released at once.

Linux Voice Assistant playback (TTS, timer chimes, announcements) feeds a second bus of the same shape, the voice sink,
selected by `--audio-output-device pipewire/<sink>` in its unit — LVA plays through libmpv, whose native PipeWire
output outranks pulse on mpv ≥ 0.36 and ignores `PULSE_SINK` (Sendspin, by contrast, plays through the ALSA-pulse
path, which is why the background bus can be selected by environment).

Loudness is two independent gains on those bridges, not the sink volume: the manager pins the output sink at 100% and
holds the music level on the background bridge (with aux and any direct route following it, and ducking dipping to a
share of it) and the voice level on the voice bridge. Music at 5% with voice at 50% plays voice at 50%; music at 80%
with voice at 30% plays voice at 30%. `set-music-volume` and `set-voice-volume` on the control socket move them; the
sink itself carries only mute, so muting silences everything at once — `set-output-mute` moves it, and the manager
reads the sink's mute back on every pass, so a mute made by any other client reaches the deck without the controller
polling for one. Because the gains sit on the persistent bridges
rather than on clients' short-lived streams, a fresh TTS stream cannot play a syllable at the wrong level, and any
stray client that plays straight at the pinned sink is snapped to the music level on the next reconcile. Its bridge stream carries the voice volume, set over the control socket with
`set-voice-volume` and held as an absolute level: the manager divides the target by the output sink's volume on every
reconcile, so voice speaks at the same loudness whether the music is loud or quiet (it can never exceed the master).
Because the gain sits on the persistent bridge rather than on LVA's short-lived playback streams, a fresh TTS stream
cannot play a syllable at the wrong level. The bus is never ducked — it is the thing everything else ducks for.

It also mirrors the HiFiBerry output monitor into the XVF3800 USB playback endpoint. Nothing is connected to the
ReSpeaker speaker jack; the stream exists to give the XMOS DSP the far-end reference required for acoustic echo
cancellation.

The initialisation service selects the DAC2 ADC Pro unbalanced line inputs, sets ADC gain, and limits the initial
hardware output level. Both are adjustable in the Ansible variables.

## Service boundaries

- `smartamp-hifiberry`: applies hardware mixer settings after ALSA detects the HAT.
- `smartamp-usb-audio-gadget`: creates the stereo UAC2 peripheral on the Pi 5 USB-C controller.
- `smartamp-audio-manager`: maintains PipeWire defaults, switchable routes, the background bus and its ducking gain,
  the voice bus and its volume, and the output sink's mute, driven by `pactl subscribe` events and a Unix control socket.
- `smartamp-sendspin`: runs the Sendspin player that Music Assistant discovers and streams to.
- `smartamp-voice-assistant`: pinned OHF Linux Voice Assistant checkout and Python virtual environment.
- `smartamp-controller`: maps Assist events to background ducking and XVF3800 effects, and renders/handles Stream Deck+
  controls without Elgato desktop software. When remote tiles are enabled it also listens on one authenticated WebSocket
  port, through which another computer on the LAN pushes key faces onto the deck's REMOTE page and receives the presses
  back (`apps/controller/src/remote/server.mts`); the controller remains the only owner of the deck.

The controller is one long-running Node process because ducking and both control
surfaces consume the same voice, mute, media, and audio-route state.
The audio manager remains a separate Python daemon because it continuously
reconciles the PipeWire graph and owns its gain nodes.

The controller's unit is ordered after nothing but the service account's session,
which is what creates the runtime directory its sandbox mounts. Its companions
are wanted rather than required: the audio manager spends its own startup waiting
for PipeWire and the voice assistant blocks for up to a minute waiting for the
audio graph, so waiting on either would leave the panel dark for the whole boot,
and requiring either would take the deck down during an outage the deck exists to
report. It polls both sockets instead, keeps driving Home Assistant and the LED
ring throughout, and says where it has got to: an amber ring and a "STARTING UP"
strip while it is still connecting, then a red icon and a banner once a
subsystem is genuinely late rather than merely slow.

The controller switches routes and requests ducking by sending commands over
the audio manager's Unix control socket in the runtime directory, and mirrors
the state events it receives back onto the Stream Deck. The manager reconciles
immediately on `pactl subscribe` events and on route commands, with a 15-minute
safety-net resync in case an event is missed. Route state lives in memory: the
controller re-asserts its cached toggles when it reconnects after a manager
restart, and a reboot returns every route to its configured default.

One piece of upstream timing is corrected as events arrive rather than in each
thing that reacts to them. Linux Voice Assistant answers `tts_finished` as soon
as mpv reports end-of-file, but mpv buffers 0.8s of output, so the reply is
still coming out of the voice bus for about 0.6s afterwards (measured on this
device). Delivered as it arrives, that event ends the speaking ring, the voice
key, and the duck mid-word, so `voice/lva-client.mts` holds the end of a reply
back before applying it. A pipeline that has moved on in the meantime abandons
the held event, and cancelling is exempt because stopping the player discards
its buffer with it.

A duck request is scoped to the connection that made it, so the socket doubles
as the liveness check. The controller re-asserts an active duck on reconnect,
and the manager releases it the moment the connection drops, which is what
keeps a controller crash from leaving background audio quiet.

The Stream Deck driver uses `@elgato-stream-deck/node`, which supports the Plus model's eight key LCDs, four rotary
encoders, and 800×100 touch strip. The ReSpeaker module uses USB vendor-control transfers for XVF3800 LED effects.
Everything runs headlessly.

Two of the ring's states are drawn from live audio rather than handed to the
firmware. While the satellite is listening, the controller reads the XVF3800's
own DSP over the same vendor-control transport — a processed direction of
arrival and a speech energy per beam — and paints ripples running outwards from
whoever is talking, which is why that state no longer uses the firmware's
direction effect. Those reads answer with a status byte ahead of the payload and
must be paced and retried, so every transfer to the device is serialised through
one queue; a frame written mid-read would come back as the read's answer.

The device reports nothing about its far end, so the speaking pulse is metered
in the audio manager instead. The voice bus is a null sink of its own, meaning
its monitor carries the assistant's speech and no music; the manager captures
that monitor, reduces it to one level per 40 ms block, and sends the levels to
whichever control-socket connections asked for them. The request is held against
the connection exactly as a duck request is, and the controller only asks while
a state that paints from it is showing, so nothing is captured between replies.

The panel dims and then switches itself off when the room is empty. `streamdeck/sleep.mts` follows a Home Assistant
presence sensor over that same connection and writes one field of shared state — `lit`, then `dim` as a five-second
warning, then `off`. The renderer reacts to it exactly as it reacts to the deck being unplugged, dropping the mounted
tiles so their animation timers and entity watches stop with the light.
Nothing else sleeps: the wake word, the ReSpeaker ring, and background playback are untouched. It fails towards a lit
panel — an unreachable Home Assistant, a sensor reporting `unavailable`, or a hand on a deck the sensor thinks nobody is
near all keep it awake, and the first press on a dark panel wakes it without also running the key.

Each key is a tile that owns its own behaviour and face; the touch strip is one full-width display owned by
`streamdeck/strip.mts`, which picks between screens — the dial being turned, a notification, or what is playing. Home
Assistant automations reach that strip by firing a `smartamp_notify` event on the same WebSocket the entity cache is
built from, so a doorbell or a finished washing machine needs no entity and no inbound port on the Pi.

A small local LVA launcher adapter supplies pause, idle, and natural media
completion events missing from the pinned upstream peripheral protocol. This
keeps the Stream Deck play/pause state accurate without modifying the verified
upstream checkout. The same adapter completes `stop_pipeline`: upstream only
cancels a response that has reached speaking, so pressing cancel while the
satellite is listening or thinking left the microphone streaming, Home Assistant
still running the pipeline, and no idle event for the deck to follow. The
adapter withdraws the request from Home Assistant, drops the wake chime's
callback — which would otherwise start the very stream being cancelled — and
emits the idle the control surface waits on.

The service units use a compact isolation baseline: core system configuration is
read-only, home directories are hidden, temporary directories are private, and
privilege escalation is blocked. File ownership protects application and state
paths, while USB, network, PipeWire, and configfs APIs remain available to the
hardware features that need them. The root USB-gadget service retains only its
mount and module-loading capabilities.

The controller also holds a second, separate connection to Home Assistant: its
WebSocket API, authenticated with a long-lived access token, used by the Stream
Deck keys that read and change house state. It subscribes with
`subscribe_entities` to exactly the entities a visible key is watching — a
compressed per-entity feed, replaced when a page change moves that set — so a
house with hundreds of entities costs this daemon neither the traffic nor the
cache of the ones it never draws. Losing the connection clears that
cache, and the affected keys draw an unknown state rather than a stale one that
still looks live. With no token configured the whole thing is replaced by an
offline stand-in and the keys behave the same way, permanently.

Assistant timers are the one thing that connection cannot carry as an entity:
Home Assistant keeps them per device, and the satellite only mirrors them to the
deck over the voice socket. Acting on one is an intent, which has no WebSocket
command, so the controller posts it to `/api/intent/handle` with the same token
— naming the device behind the satellite entity, resolved once from the entity
registry. That is what makes the TIMER key and a spoken "set a timer" the same
timer rather than two that happen to look alike.

Home Assistant and Music Assistant are not part of this image. The Pi is a client endpoint: the ESPHome protocol
connects voice to the remote HA instance, the HA WebSocket API connects the control surface to it, and the Sendspin
protocol connects the local player to the remote Music Assistant.
