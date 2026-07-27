# Configuration

All supported settings live in `ansible/inventory/group_vars/all.yml`. Re-run `make provision` after changing them.

## Audio

`hifiberry_aux_gain_db` is the analogue ADC input gain. Start at `0`; line-level sources can clip if this is raised too
far. `hifiberry_output_volume_percent` is the DAC's hardware output ceiling, not the playing loudness — its percent
scale is logarithmic (about −1 dB per point below 100), so values much below 90 attenuate to silence; leave it at 100
and control loudness in PipeWire.

Loudness itself is two independent levels held by the audio manager: the **music level** (Sendspin, USB computer audio,
and aux) and the **voice level** (everything the assistant plays). The output sink is pinned at 100% and each level is
a gain on that class's own bridge stream, so voice speaks at its set loudness whether the music is at 5% or 80%. The
volume dial and Home Assistant move the music level; `smartamp_startup_volume_percent` is where it starts each boot so
the device always wakes at a predictable loudness. Because the sink is pinned, the manager also holds any stream that
plays straight at the output — something not routed through a bus — at the music level rather than letting it play at
full amplifier gain.

Device match expressions search every PipeWire/Pulse node property. Use `pactl list sinks` and `pactl list sources` on
the Pi if your firmware exposes different names.

## Logging

No component writes a log file of its own. Every service logs to stdout/stderr and systemd captures it in the journal,
so `journalctl -u <unit>` is the only place to read logs: `smartamp-controller`, `smartamp-audio-manager`,
`smartamp-voice-assistant`, `smartamp-sendspin`, `smartamp-usb-audio-gadget`, and `smartamp-hifiberry`.

`smartamp_journal_in_ram` chooses where that journal is stored, through
`/etc/systemd/journald.conf.d/smartamp.conf`:

| Setting | Storage | On-disk location | Cap | Survives reboot |
| --- | --- | --- | --- | --- |
| `smartamp_journal_in_ram: true` | `volatile` | `/run/log/journal/` (RAM) | 32M | No |
| `smartamp_journal_in_ram: false` | `persistent` | `/var/log/journal/` (SD card) | 64M | Yes |

Flip it to `false` while chasing a crash so the evidence survives, and back to `true` for normal duty to spare the card.

Set `smartamp_debug_logging: true` and re-provision to trace every action — deck input, route commands, Home Assistant
service calls, LVA commands, and each `pactl` invocation the audio manager makes. It sets `SMARTAMP_LOG_LEVEL=debug` in
the controller and audio-manager units; both default to `info`.

Set `smartamp_aux_enabled` and `smartamp_usb_enabled` to choose whether aux and USB monitoring start on boot. Both
default to off. The USB route is additionally gated on the computer actively streaming to the gadget: the audio
manager only builds the bridge while the gadget card's `Capture Rate` control reads a non-zero rate, because the
gadget's capture clock only ticks while the host holds its playback stream open. A computer that is plugged in but
playing to another output, or a cable that was unplugged, leaves a dead clock that would stall the whole output graph
and silence everything else — including Sendspin and Home Assistant media on the background bus. Enumeration
(`/sys/class/udc/*/state` reading `configured`) cannot gate this: with the recommended VBUS-blocking adapter the port
never reports a disconnect, so that file stays `configured` after an unplug until the next replug. Toggling USB on
with nothing plugged in or nothing playing is therefore safe — the route simply waits for audio to arrive.

The gadget's ALSA card boots with no active profile: it has no PipeWire-visible mixer path, so WirePlumber is offered
only "off" and "pro-audio" and picks neither. While the USB route is enabled the audio manager switches a parked card
to its pro-audio profile itself; that is what creates the capture node it bridges. Keep `usb_audio_sample_size_bytes`
at `2` (16-bit) — the Pi 5's dwc2 gadget controller corrupts 3-byte (24-bit) samples on its isochronous endpoints,
which plays as loud static with the audio faintly underneath.

The gadget advertises a UAC2 mute/volume control, and the connected computer's writes to it land on the gadget card's
`PCM Capture` ALSA controls. The audio manager keeps those and the music level plus output mute converged in both
directions (an `alsactl monitor` stream wakes it on host changes; sink changes it already sees): change the volume on
the computer and the amp follows, turn the amp's dial and the computer's slider follows. Whichever side moved since
they last agreed wins, and when a computer first plugs in the amp's current volume seeds its slider.

The aux bridge is loaded once, at boot, whether or not the route is on; the toggle fades the bridge stream between
silent and full over ~200 ms. Connecting the stream on demand used to land any DC offset on the line input as a step on
the speakers — at full amplifier gain, since the volume dial only scales PipeWire — so the pop-prone connect now
happens exactly once, muted, while nothing is playing. Stream Deck route toggles last until the next reboot; every boot
starts from these inventory defaults.

Voice ducking is enabled by `smartamp_voice_ducking_enabled`. Sendspin and USB computer audio share the
`smartamp_background_sink_name` bus and fade down to `smartamp_voice_duck_volume_percent` per cent of their normal level
during an Assist interaction — the value is the level the music plays *at* while ducked (reduced to 15%, not by 15%),
and it returns to 100% afterwards. `smartamp_voice_duck_fade_ms` controls the transition. The controller requests
ducking over the audio manager's control socket, which releases the request automatically if the controller disconnects.

Aux is deliberately not on the duckable bus. It continues at its selected level during voice interactions. Set the
generated source target to `background` as a code-level extension if aux should follow the same policy.

Voice playback has a bus of its own, `smartamp_voice_sink_name`, so how loud the assistant speaks is fully independent
of the music level: TTS, timer chimes, and announcements play at `smartamp_voice_startup_volume_percent` whether the
music sits at 5% or 80%. From boot onwards the level belongs to the deck: the VOICE VOL key on the INFO page sets it,
and the volume dial adjusts it live whenever Assist is listening, thinking, speaking, or ringing a timer. Like the
route toggles both levels survive an audio manager restart (the controller re-asserts them) but return to the
inventory defaults on reboot. Mute is the exception to the independence: it lands on the output sink itself, silencing
music and voice alike.

## SD-card endurance

The image is tuned for minimal flash writes. `smartamp_journal_in_ram: true`
keeps systemd logs for the current boot in RAM instead of on the card (see
Logging above for the paths and the reboot trade-off), and
`smartamp_swapfile_enabled: false` removes the
stock dphys-swapfile so memory pressure cannot grind the card — if RAM is ever
exhausted, the kernel OOM-kills the largest process and systemd restarts it.
Route toggles and duck requests live in the audio manager's memory and travel
over a Unix socket in the runtime directory; the audio status file lives under
`/run`, which is RAM-backed. Routine operation therefore never writes to the
card, and route toggles reset to inventory defaults at boot.

## Voice

`voice_assistant_version` pins the upstream release tag that is checked out,
exactly as `sendspin_version` pins the Sendspin client. Bump the one value to
upgrade. The upstream setup script installs its declared Python dependencies into
`/opt/smartamp/linux-voice-assistant/.venv`; no container runtime is used.
`voice_assistant_wake_model` defaults to `okay_nabu`. Custom OpenWakeWord model
files can be placed in `/var/lib/smartamp/lva/wakewords` and selected by name.
The remote Home Assistant Assist pipeline supplies speech-to-text,
conversation handling, and text-to-speech.

The XVF3800 already performs AEC, beamforming, dereverberation, noise suppression and gain control. Leave LVA software
noise suppression and auto-gain disabled initially to avoid processing the signal twice.

The device's two USB capture channels are separate DSP outputs, not a stereo pair: channel 0 is the Conference stream (
tuned for human listeners), channel 1 the ASR stream (tuned for recognition). `smartamp_voice_capture_channel` (default
`1`) tells the audio manager which channel to publish as the mono default source; set it to `null` to capture a device
unmapped (a genuinely mono microphone). The voice assistant's capture is hardcoded to one channel in its systemd unit
because that mono source is the entire capture either way — a second LVA channel would be forwarded to Home Assistant
labelled as a far-end echo reference for server-side AEC, and on the XVF3800 that channel carries the voice, not an echo
reference.

## ReSpeaker effects

Inventory carries only `respeaker_led_enabled` and `respeaker_led_brightness`.
Which appearance each voice state shows is compiled into the controller and
edited in `apps/controller/src/voice/led-states.mts`, exactly as the deck
layout is: one line per state, built with the `Leds` helpers, so restyling the
ring is an edit and a redeploy rather than an inventory change.

```ts
thinking: Leds.spin('#7c4dff'),
listening: Leds.direction('#001018', '#00e5ff'),
```

| Helper                            | What the ring shows                                                                                                                 |
|-----------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|
| `Leds.off()`                      | Every LED dark.                                                                                                                     |
| `Leds.solid(color)`               | One steady colour.                                                                                                                  |
| `Leds.pulse(color)`               | The colour swelling and fading (firmware breathing).                                                                                |
| `Leds.rainbow()`                  | The firmware rainbow cycle.                                                                                                         |
| `Leds.colors([…])`                | A fixed colour per LED — the list repeats around the ring, so an explicit rainbow (`rainbowColors()`) or a gradient is just a list. |
| `Leds.spin(color \| [...])`       | The colours rotating like a loading spinner; a single colour gets a comet tail. `periodMs` sets the rotation time.                  |
| `Leds.blink(color)`               | The whole ring flashing on and off.                                                                                                 |
| `Leds.progress(fraction, color)`  | A fraction of the ring lit, for readouts.                                                                                           |
| `Leds.direction(base, highlight)` | The LEDs facing the detected voice light in the highlight colour (the XVF3800's direction-of-arrival tracking).                     |

Every helper accepts a `brightness` override; `spin` and `blink` are animated
by the controller, which streams per-LED frames over USB, while the other
effects run inside the XVF3800 firmware.

The ring is purely reactive: it renders the configured appearance for the
current voice, media, timer, mute, or error state and nothing else. There is
no separately controllable lamp mode, no persisted LED state, and no Home
Assistant light entity.

Feature flags are reversible: disabling voice, Sendspin, USB gadget audio,
or every controller consumer stops the relevant service and removes its
installed runtime artifacts. Persistent preferences and downloaded wake-word
models under `/var/lib/smartamp` are retained for a later re-enable.

## Stream Deck+

`streamdeck_enabled` turns the control surface on or off for this unit. Set it
to `false` for an LED-only deployment with no deck attached.

The key and dial layout, and the panel brightness, are defined in the
controller itself at `apps/controller/src/streamdeck/layout.mts`, not in the
inventory — edit that file and run `make deploy-controller`. Every available
action, with examples and the key feedback each one produces, is listed in
[controls](controls.md). A mistyped `route`/`volume` command is a compile
error, and `make test` rejects any action the catalog does not understand.

### Home Assistant

`home_assistant_url` connects the controller to Home
Assistant's WebSocket API. This is what the keys that *show* house state need —
the fan, blinds, PC, scenes, timer, temperature, weather, the lights dial, and
the media transport — because they read entity state as well as change it. The
same connection carries what the touch strip shows: the playing track's title and
artist, and the notifications automations push with the `smartamp_notify` event
(see [controls](controls.md#notifications-from-home-assistant)). Neither needs
any setting of its own.

Setting the URL turns the integration on and makes `HOME_ASSISTANT_TOKEN`
required in the [secrets file](#secrets) — create that token in Home Assistant
under your profile → Security → Long-lived access tokens. Leave the URL empty to
run without Home Assistant: those keys stay on the deck and draw an unknown
state, and nothing else is affected.

Which entities the keys drive is *not* configured here. Entity ids are compiled
into the layout beside the keys that use them, in the `HA` block at the top of
`apps/controller/src/streamdeck/layout.mts`; a typo there fails `make test`
rather than becoming a key that presses successfully and reaches nothing.

The presence sensor that puts the deck to sleep is one of those entities, in the
`SLEEP` block of the same file along with how long the panel outstays you. See
[sleeping when the room is empty](controls.md#sleeping-when-the-room-is-empty);
running without Home Assistant simply keeps the deck lit.

### Remote tiles

`remote_tiles_enabled` and `remote_tiles_port` run a
small WebSocket server inside the controller that lets another computer on the
LAN push key faces onto the deck's REMOTE page and receive the presses back —
see [controls](controls.md#remote-tiles-from-another-computer) for the protocol
and `apps/remote-demo` for a runnable client.

This is the one inbound port the controller opens, so the feature is off by
default and never starts without a token: set `remote_tiles_enabled: true` and
put a long random `REMOTE_TILES_TOKEN` in the [secrets file](#secrets).
Disabling the flag again closes the port on the next provision, and the REMOTE
page leaves the deck with it.

### Secrets

The two tokens are the only settings that do not live in `all.yml`. They are
typed once on the Pi itself, in `/etc/smartamp/secrets.env`:

```sh
sudo mkdir -p /etc/smartamp
sudo nano /etc/smartamp/secrets.env
```

```sh
HOME_ASSISTANT_TOKEN=eyJhbGciOi...   # when home_assistant_url is set
REMOTE_TILES_TOKEN=a-long-random-string   # when remote_tiles_enabled is true
```

Provisioning never writes this file and never reads the values out of it. It
checks on the Pi that each key a switched-on feature needs has a non-empty
value, and stops with that key named if not, so a forgotten token fails before
anything is reconfigured rather than becoming a controller that crash-loops.
Ansible does tighten the file to `0600 root:root` on each run; systemd loads it
into the controller's environment as root before dropping to the service
account, so nothing else on the Pi can read it.

Because no secret ever reaches this repository or the control computer, there is
nothing here to encrypt and no vault password to manage. After changing a value,
restart the service for it to take effect:

```sh
sudo systemctl restart smartamp-controller
```
