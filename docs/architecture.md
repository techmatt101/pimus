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

Aux (DAC2 ADC Pro only) --+                                                   |
Computer --USB-C UAC2------+-- audio inputs app --+                             |
                                                  +--> duckable music bus ------+--> HiFiBerry DAC --> amplifier --> speakers
Sendspin / MA ------------------------------------+                             |
Linux Voice Assistant TTS/media --> voice bus ----------------------------------+
```

The amplifier is either an AAmp60 bolted to the DAC2 ADC Pro, or an Amp100 that is itself the DAC. An Amp100 has no
ADC, so the aux path above does not exist on one; see [configuration](configuration.md).

## Audio ownership

PipeWire and WirePlumber run in a persistent `smartamp` system-user session. The audio manager finds the output by a
configurable regular expression instead of an unstable ALSA card number, makes the music bus the default sink, and
mixes whatever plays into that bus. Anything that plays to the default is playing music, so it lands on the bus behind
a trim and the music level rather than straight at the pinned hardware output. The manager knows nothing about where
a stream comes from — no card, no gadget, no capture node — and nothing about the microphone: the local inputs are the
[audio inputs app](audio-inputs.md), and what the assistant records is PipeWire's own configuration, described below.

The XVF3800's USB capture is not a stereo microphone: the chip beamforms its four mics internally and presents two
independent DSP outputs — channel 0 is the Conference stream (post-processed for human listeners) and channel 1 is the
ASR stream (tuned for wake-word and speech recognition). The chip's pipeline, its reference requirements, and which
module owns each part of it are in [xvf3800](xvf3800.md). A unit may carry a ReSpeaker Lite instead
([respeaker-lite](respeaker-lite.md)): the same remap then lifts its channel 0, the processed output, and the AEC
reference lands on its playback endpoint the same way. Which array is fitted is a row in `boards.yml` that inventory
reads its defaults from; nothing in either daemon branches on it. Recording the device in mono would downmix the two, so
Ansible deploys two pieces of PipeWire configuration: a WirePlumber rule
(`60-smartamp-voice-input.conf`) that renames the array's capture node to the fixed `smartamp_voice_input` and starts
its card on its full-duplex profile, and a loopback drop-in (`60-smartamp-voice-capture.conf`) that lifts exactly the
ASR channel (`smartamp_voice_capture_channel`, default 1) out of that node into the mono `smartamp_voice_capture`
source, which outranks every other source for the default. The loopback targets the node by name and never falls back,
so an unplugged or power-cycled array means silence until it returns and the link re-forms on its own. Linux Voice
Assistant records this one channel; it must not be given a second channel, which it would forward to Home Assistant
advertised as a far-end echo reference for server-side AEC — on this device that second channel is the voice itself,
not a reference. The one microphone-side thing the audio manager does is send the array its echo reference.

The voice service waits for a fresh audio-manager status file naming the output sink and voice bus, and for PipeWire's
source list to carry both capture nodes. It then lets the audio library resolve PipeWire's selected defaults; `default`
is not passed as a literal hardware-device name.

Every music input — Sendspin, the USB computer, and aux — feeds one named music bus. Its monitor is bridged to
HiFiBerry through a single gain-controlled loopback; only Linux Voice Assistant bypasses it. The bus exists whether or
not the assistant ducks it, because it is the music path either way. The controller requests ducking on
wake/listen/think/TTS, announcement, and timer events by sending `set-duck` over the audio manager's control socket. The
manager holds the request against that connection, so the music cannot remain quiet indefinitely: if the
controller stops unexpectedly the socket closes and the duck is released at once. The assistant's own media player
plays on the voice bus too, so a clip Home Assistant sends that entity (`media_player.play_media`, with or without
`announce`) ducks the music for as long as it plays: the launcher adapter emits the playing and idle events for it,
and the controller holds that reason apart from the pipeline's, so a clip ending under a reply restores nothing
until both are over.

Linux Voice Assistant playback (TTS, timer chimes, announcements) feeds a second bus of the same shape, the voice sink,
selected by `--audio-output-device pipewire/<sink>` in its unit — LVA plays through libmpv, whose native PipeWire
output outranks pulse on mpv ≥ 0.36 and ignores `PULSE_SINK` (Sendspin, by contrast, plays through the ALSA-pulse
path, which is why the music bus can be selected by environment).

Loudness is two independent gains on those bridges, not the sink volume: the manager pins the output sink at 100% and
holds the music level on the music bridge (with aux and any direct route following it, and ducking dipping to a
share of it) and the voice level on the voice bridge. Music at 5% with voice at 50% plays voice at 50%; music at 80%
with voice at 30% plays voice at 30%. `set-music-volume` and `set-voice-volume` on the control socket move them, and
`set-source-trim` moves one input's share of the music level. Under all of those sits the card's hardware ceiling,
the `Digital` control, which the manager reads back on every pass and reports as `output_volume`. It boots at the
inventory value, written by `hifiberry-init.sh`, and `set-output-ceiling` moves it from there, no lower than 70%
(the control's scale is about a decibel a point, so lower would be a dial that silences the amp); the card keeps it
across a manager restart and the next boot puts the inventory value back. It is the amplifier's protection rather
than a gain, so it is a level to set and leave, not one to ride.

The manager is a mixer, and its channels are the `sources` in `audio.json`: a list of names, each with a trim and,
for the switchable ones, an on/off. A stream on the music bus belongs to the source its `smartamp.source` property
names; a stream with no tag belongs to `default_source`, which inventory names `sendspin` — Sendspin's own ALSA-pulse
stream, and anything that plays to the default sink. The manager holds every stream of a source at that source's trim
(or at silence, faded, while the source is off), snaps a newly seen stream straight to it, and never asks how the
stream got there. Only the sources a unit has are listed, so the deck greys a route key for one it cannot have.

Everything the manager says about the graph is one document, written to `smartamp-audio-status.json` and sent over
the socket as the `state` event with `event` in front. Each bus section carries its own level (`music_bus.volume` and
`music_bus.muted`, `voice_bus.volume`, `music_bus.ducked`), and `sources` lists every configured source as
`{trim, enabled?, available}`: `enabled` only on a switchable source, `available` when at least one stream carrying
its name is on the bus. The controller reads that one list for the LEVELS and ROUTE keys, and the strip's cyan USB
icon is `sources.usb.available` — a computer streaming to the gadget, switched on or not.

The streams themselves come from the [audio inputs app](audio-inputs.md) for the aux line-in and the USB gadget: it
finds each input's capture node, runs a `pw-loopback` into the bus born at volume zero and tagged with the source's
name, gates the USB one on the computer actually streaming, keeps the gadget's mixer agreed with the bus register, and
owns no trim and no toggle. The root gadget setup service remains separate.

The music level also has a second face: the music bus sink's own volume and mute. That is an ordinary PipeWire control
anything can read, write, and subscribe to, and the manager keeps it and the level agreed in both directions on the
last-mover-wins terms — so a player watching its output device moves the room by moving
it, and is told through the same sink event when the dial or a USB host moved it instead. It is a control surface, not
the gain: the bus is created with `monitor.channel-volumes=false` so that volume never reaches the monitor the bridge
carries, which means a property that stopped applying could only ever play the room quieter than asked, never louder.
The voice bus is a sink of its own and is not mirrored, so the assistant keeps its level whatever a music player does.
The volume mute (`set-music-mute`, `music_bus.muted` in the state event) sits beside the music level as one boolean: while it
is on, every path that follows the music level plays at 0% and the level itself is untouched, so an unmute lands
where the dial was. The voice bus is not a music path, so the assistant's replies, timers, and announcements made
through the satellite still play; an announcement sent to the Music Assistant player is music and is muted with it.
The mute is not a sink mute: the sink's own mute belongs to the manager alone, as the rebuild guard below. A ready
bridge gives new client streams an already-applied gain. Direct clients on the hardware
sink follow the music level both on a volume command and on reconciliation, but can still start playing before the
manager sees them. The voice bus is never ducked.

A bus bridge is asked to start silent (`node.param.Props` on its stream), and the manager still mutes a newly
discovered output before adjusting gains and guards every new bridge it loads into the output, as the backstop for a
stream that came up loud anyway. A fresh bridge is held at nothing while the guard lifts, and only then faded up to
its level over a quarter of a second, so the first moment of music after an idle spell, a manager restart, or a
bridge PipeWire recreated arrives as a ramp rather than a step. The inputs app's streams need no guard: each is
created at volume zero inside its own PipeWire client, and the manager's first sight of it fades it up to its
source's trim, so it is never audible before its gain lands and never arrives as a step. Direct hardware clients
still follow the manager's gain enforcement. An AEC-only connection does not need the speaker guard.
An unpublished playback stream keeps the guard held and schedules another pass a second later while the rest of the
graph is reconciled and published. A failed command removes readiness status. The guard releases only after playback
gains are applied and the unmute is successfully written; failed writes retain the guard for retry, and a bridge
not yet faded in stays silent until a pass settles.

Because nothing but the guard is meant to mute the sink — the volume mute is a gain, never a sink property — the
manager keeps no state about it: a sink found muted at
start-up — by a daemon killed mid-rebuild, or by WirePlumber restoring that mute across a reboot — is guarded again
and released once the first pass settles, and a mute another client leaves during normal operation is undone on the
next pass. Sound always comes back. The guard is a mute switch, not a sample ramp. Direct clients and independently
recreated streams can still play before the manager sees them; driver and amplifier transients still need hardware
validation.

It also mirrors the HiFiBerry output monitor into the XVF3800 USB playback endpoint. Nothing is connected to the
ReSpeaker speaker jack; the stream exists to give the XMOS DSP the far-end reference required for acoustic echo
cancellation.

Those persistent loopbacks are also what keep the audio hardware running through silence, so after a configurable
quiet spell (`smartamp_idle_teardown_seconds`) the manager unloads the bridges, the AEC reference, and the muted aux
bridge and lets the devices suspend. The null sinks and the voice capture path stay, so clients keep their targets and
the wake word keeps hearing; the next client stream, voice session, or route toggle rebuilds the graph within about a
second.

The initialisation service selects the DAC2 ADC Pro unbalanced line inputs, sets ADC gain, and limits the initial
hardware output level. These are adjustable in the Ansible variables. A failed mixer command fails that service,
which the audio manager requires. Ansible restarts its dependent playback services after restarting the manager.

Voice startup waits for the configured mono capture source and the voice bus, allowing an intentionally unbridged
idle bus. A missing configured capture channel never falls back to a different DSP output. A microphone-worker
failure terminates LVA through the small `smartamp_audio_recovery.py` adapter, allowing its existing systemd restart
policy and readiness gate to reopen the device. Silent or blocked capture without an exception still needs diagnosis.

## Service boundaries

- `smartamp-hifiberry`: applies hardware mixer settings after ALSA detects the HAT.
- `smartamp-usb-audio-gadget`: creates the stereo UAC2 peripheral on the board's USB-C controller.
- `smartamp-audio-inputs`: brings the local inputs onto the music bus — the aux capture while the graph is awake,
  the USB gadget's capture while a computer streams to it — as tagged client streams born at volume zero, and keeps
  the gadget mixer agreed with the bus register. It holds no trim and no toggle and serves no socket; the doctor reads
  its status file. Deployed only on a unit with an input.
- `smartamp-audio-manager`: the mixer. Maintains PipeWire defaults, the music bus and its ducking gain, every source's
  trim and toggle on that bus, the voice bus and its volume, and the volume mute, driven by `pactl subscribe` events
  and a Unix control socket.
- `smartamp-sendspin`: runs the Sendspin player that Music Assistant discovers and streams to. Run with
  `--hardware-volume`, so it sets, reads, and subscribes to its output sink's volume — the music bus register — rather
  than applying a gain of its own.
- `smartamp-voice-assistant`: pinned OHF Linux Voice Assistant checkout and Python virtual environment.
- `smartamp-controller`: maps Assist events to music ducking and XVF3800 effects, and renders/handles Stream Deck+
  controls without Elgato desktop software. The deck half is an addon behind one dynamic import
  (`apps/controller/src/streamdeck/control-surface.mts`), taken only when `streamdeck_enabled` is on, so a unit
  without one loads none of it and is never sent the drawing packages it needs. When remote tiles are enabled it listens
  one authenticated WebSocket port, through which another computer on the LAN pushes key faces onto the deck's REMOTE
  page and receives the presses back (`apps/controller/src/remote/server.mts`); that listener is part of the same addon,
  and the controller remains the only owner of the deck. That dynamic import is also where the deployed code is cut in
  two: `make build` compiles the sources with `tsc` and then bundles them into `index.mjs`, the
  `streamdeck/control-surface.mjs` addon, and one shared chunk, which is what a Pi is sent instead of 75 modules.

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
safety-net resync in case an event is missed. A level it wrote itself comes
straight back as a `change` event, which it treats as an echo for a quarter of
a second rather than a reason to reconcile, so a volume detent costs the run
of `pactl` calls that applies it and nothing more; the controller sends one
level command per kind at a time and only the newest asked for meanwhile, so
a fast turn never queues a detent behind the last. On clean exit the manager
atomically saves music volume and mute, voice volume, and source trims and
toggles to `/run/user/<uid>/smartamp-audio-state.json`. It restores those settings
before its first graph reconciliation, so playback never waits for the controller
to restore a mute after a clean restart. The controller also re-asserts its cache
on reconnect, including choices made while disconnected. Missing or invalid state
uses the inventory defaults; an abrupt exit leaves the last clean snapshot, and
a reboot clears the runtime file. Ducking, metering, idle state, graph identities,
and the hardware ceiling are not saved. Recreating a music bus seeds its volume
register from the manager's current level and mute instead of adopting the new
sink's defaults.

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
keeps a controller crash from leaving the music quiet.

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
tiles so their animation timers and entity watches stop with the light. Dimming stops short of that: the faces stay
mounted and current, but the renderer freezes the time it hands them and the strip drops to a once-a-minute frame, so
every animation holds still and resumes where it stopped.
Nothing else sleeps: the wake word, the ReSpeaker ring, and music playback are untouched. It fails towards a lit
panel — an unreachable Home Assistant, a sensor reporting `unavailable`, or a hand on a deck the sensor thinks nobody is
near all keep it awake, and the first press on a dark or dimmed panel wakes it without also running the key.

How bright that lit level is comes from the room, not from a key: `streamdeck/auto-brightness.mts` reads an illuminance
sensor over the same connection and writes the panel percent, rate-limiting the sensor's constant drift to one change a
minute while letting the jump of the lights coming on land at once. A dark panel writes nothing and takes the newest
reading whole when it wakes, which is the same moment the room's lamps come on. The SETTINGS page's `BRIGHTNESS` key
is the way into that policy: its dial tunes the lux the room counts as fully lit, and a second press switches the
following off and leaves the level to the same dial by hand.

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
emits the idle the control surface waits on. A cancel also has to outlive the
instant it happens: Home Assistant can already be running the intent when the
request is withdrawn, so the adapter ignores what that abandoned run reports
next rather than letting a reply generated a moment too late start speaking into
a quiet room. The ending it emits is marked cancelled, which is how the
controller knows to drop the ring and the duck at once instead of holding them
for the output buffer a reply that ran out would still have.

The spoken stop word reaches the same cancel. Upstream detects it on every audio
chunk but only acts on it over a spoken reply, an announcement, or a ringing
timer, so an assistant waiting on Home Assistant hears "stop", recognises it,
and throws it away. The adapter arms the word for thinking as well, so a request
that is taking too long or was never wanted ends on the word from either side of
the reply. Listening is deliberately left out: those words are the request
itself, and "stop the music" would cancel it rather than run it.

The same adapter decides when the request is over. Upstream streams the
microphone from the wake word onwards and stops only when told, and Home
Assistant tells it after a fixed run of silence, so one figure has to serve both
a three-word command and a sentence with a pause in the middle of it. The
adapter scores 10ms frames locally and closes the speech-to-text stream itself
once the request sounds complete — a short silence after a finished phrase, a
longer one after a word too short to be the end of a sentence, and never at all
before enough speech has been heard. This is the graceful counterpart of the
cancel above: an audio message marked `end` lets the pipeline run on to the
intent, where `start=False` abandons it. Home Assistant's own detector, turned
up to relaxed, stays as the patient backstop for the turns the Pi declines to
end, and setting the silence to 0 hands the whole decision back to it.

Either way of stopping emits a `transcribing` state upstream has no event for.
Home Assistant only reaches the intent — what upstream calls thinking — once the
words are ready, and transcribing them is the longest part of the round trip on a
machine without a GPU. Without it the ring would show listening throughout,
which reads as a request that was never heard and invites the speaker to repeat
themselves. The controller shows it as a cyan spinner on the ring and a HEARD YOU
face on the deck, and it counts as a live pipeline everywhere one matters: the
duck holds, the panel stays awake, and the voice key cancels rather than
starting a second request.

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
