# Configuration

Every supported setting is listed and explained in `ansible/inventory/group_vars/all.yml`, which holds the answer all
the amps share. A unit overrides only what makes it that unit — its HiFiBerry board, whether a Stream Deck is
attached, its power flags, and the names it advertises — in `ansible/inventory/host_vars/<hostname>.yml`. Re-run
`make provision` after changing either, or `make provision LIMIT=<hostname>` to reconfigure one amp.

The defaults in `all.yml` are deliberately the conservative ones: no deck, no USB sound card, no bootloader power
flags. A new unit works from them and turns on what it actually has.

The physical side — what to buy, what each board can do, power and wiring — is in [hardware](hardware.md), and the
first-run walkthrough is in [setup](setup.md).

## Audio

`hifiberry_board` names the fitted board — `dac2adcpro` (DAC2 ADC Pro, the DAC the AAmp60 add-on amplifier sits on) or
`amp100` (Amp100, an amplifier with its own DAC). It cannot be detected: the recipe sets `force_eeprom_read=0` so the
chosen overlay configures the HAT rather than whatever its EEPROM claims. The overlay, whether the board has an ADC,
and whether its amplifier can be muted all follow from `ansible/roles/smartamp/vars/boards.yml`, and a setting the
board cannot honour fails preflight by name.

The Amp100 has no ADC, so it has no analogue line-in. `smartamp_aux_enabled` is refused there, the generated
`audio.json` carries no aux route at all rather than a permanently unavailable one, and `hifiberry_aux_gain_db`,
`hifiberry_aux_input_left` and `hifiberry_aux_input_right` are not written. `audio.json` lists only the routes the
hardware has — the same is true of `usb` when `usb_audio_gadget_enabled` is off — and that list is what the deck greys
its route keys against, so the AUX key on an Amp100 draws unavailable and does nothing rather than needing to be edited
out of the compiled layout. See [controls](controls.md#audio-routes--type-audio).

`hifiberry_auto_mute` (Amp100 only) ties the board's hardware mute line to the audio device opening and closing, so the
amplifier is muted whenever nothing is playing and unmuted before the first sample arrives. It is the answer to an
amplifier hissing into a quiet room, and it pairs with `smartamp_idle_teardown_seconds` below, which is what creates
that silence in the first place. Off by default: muting an amplifier can be audible as a click on some speakers.

`hifiberry_aux_gain_db` is the analogue ADC input gain. Start at `0`; line-level sources can clip if this is raised too
far. `hifiberry_output_volume_percent` is the DAC's hardware output ceiling, not the playing loudness — its percent
scale is logarithmic (about −1 dB per point below 100), so values much below 90 attenuate to silence; leave it at 100
and control loudness in PipeWire. Both boards expose that one `Digital` control.

Loudness itself is two independent levels held by the audio manager: the **music level** (Sendspin, USB computer audio,
and aux) and the **voice level** (everything the assistant plays). The output sink is pinned at 100% and each level is
a gain on that class's own bridge stream, so voice speaks at its set loudness whether the music is at 5% or 80%. The
volume dial and Home Assistant move the music level; `smartamp_startup_volume_percent` is where it starts each boot so
the device always wakes at a predictable loudness. Because the sink is pinned, the manager also holds any stream that
plays straight at the output — something not routed through a bus — at the music level rather than letting it play at
full amplifier gain.

Each music input also carries a trim of its own — `smartamp_sendspin_volume_percent`, `smartamp_usb_volume_percent`,
and `smartamp_aux_volume_percent` — the share of the music level that input plays at, for bringing inputs in line with
each other (USB computers tend to play hotter than Sendspin). All three default to 100, meaning the music level
untouched. The Sendspin trim is held on its stream into the background bus, so it applies only while voice ducking is
enabled; the aux and USB trims always apply.

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
at `2` (16-bit) — the dwc2 gadget controller corrupts 3-byte (24-bit) samples on its isochronous endpoints,
which plays as loud static with the audio faintly underneath.

The gadget advertises a UAC2 mute/volume control, and the connected computer's writes to it land on the gadget card's
`PCM Capture` ALSA controls. The audio manager keeps those and the music level plus output mute converged in both
directions (an `alsactl monitor` stream wakes it on host changes; sink changes it already sees): change the volume on
the computer and the amp follows, turn the amp's dial and the computer's slider follows. Whichever side moved since
they last agreed wins, and when a computer first plugs in the amp's current volume seeds its slider.

The aux bridge is loaded muted whether or not the route is on; the toggle fades the bridge stream between silent and
full over ~200 ms. Connecting the stream on demand used to land any DC offset on the line input as a step on the
speakers — at full amplifier gain, since the volume dial only scales PipeWire — so the pop-prone connect always
happens silent: a fresh bridge stream is snapped to 0% before it is audible and only then faded up if the route is on.
Stream Deck route toggles last until the next reboot; every boot starts from these inventory defaults.

`smartamp_idle_teardown_seconds` (default 180, 0 to disable) is the power saver: the persistent loopbacks are what
keep the HiFiBerry DAC/ADC path clocked and the XVF3800 playback endpoint awake even in silence, worth roughly a watt
at the wall. After that many seconds with nothing playing — no client stream on any sink, no USB host streaming, no
voice session, no enabled analogue route — the audio manager unloads the background and voice bus bridges, the AEC
reference, and the muted aux bridge, and the devices suspend. The null sinks stay loaded so Sendspin and LVA keep
their PULSE_SINK targets, and the wake-word capture path is untouched. Everything rebuilds within about a second of a
client stream appearing, a voice session opening (the controller's duck/meter request arrives before the first TTS
audio), the USB host starting to stream, or a route being toggled on. The rebuild pass holds the output sink muted
until every bridge gain is in place — a fresh loopback stream plays at full volume until its gain lands, which would
otherwise pop the first instant of audio through the amp at full level — so the first moment of music after a long
quiet spell arrives a beat late rather than loud. There is no echo to cancel in silence, so the AEC reference being
down while idle costs the DSP nothing. The teardown is also tied to the deck's own resting states (see
[Standby and sleep](controls.md#standby-and-sleep)): the moment the panel dims into standby or switches off asleep,
the controller reports standby over the control socket and the teardown happens at once instead of waiting out the
timeout (audio still playing keeps the bridges up regardless); when the panel relights, the bridges rebuild
proactively so the first thing played or said after walking in opens on a ready graph. Standby is held against the
controller's socket connection, exactly as a duck request is, so a controller crash releases it. In full sleep,
`smartamp_sleep_usb_power_off` additionally powers off the Pi's USB-A ports through the kernel's per-port `disable`
attribute — which both cuts VBUS and forbids re-enumeration; a bare power-off is undone by the hub driver within a
second — taking the Stream Deck and ReSpeaker down entirely. Provisioning installs a systemd-tmpfiles entry that
lets the service account write those attributes (the port devices carry no udev properties, so no udev rule can),
and a logind override that hands the board's power button to the controller as the sleep/wake toggle — pressing it no
longer shuts the Pi down. Which port attributes those are is a property of the board
(`ansible/roles/smartamp/vars/boards.yml`): four one-port root hubs on a Pi 5, and on a Pi 4B the four ports of the
internal VL805 hub listed twice, once for its USB2 half and once for its USB3 half, because power only drops when both
are switched. On both boards the sockets are ganged, so this takes every USB-A device down together. A Pi 4B needs
VL805 firmware `000137ad` or newer for the switch to do anything, and has no power button, so provisioning leaves stock
`logind` handling alone there and presence returning becomes the only wake for a slept board. A Pi Zero 2 W has an
empty list — its one OTG port takes VBUS straight off the 5V rail with no switch in the path, and its devices hang off
a self-powered hub, so disabling the root port would drop them off the bus without saving a watt — and preflight
refuses the flag rather than promise a saving that cannot happen. A device re-enumerating after a power cycle can be
probed before its capture side is ready, so the audio manager also repairs a voice card that comes back with no input
profile by switching it to the best profile offering a source.

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

`smartamp_zram_enabled: true` buys headroom back without giving up any of that.
zram is a compressed block device in RAM used as the swap device itself, sized
by `smartamp_zram_percent` (default 50, a percentage of total RAM). An evicted
page is compressed and kept in memory, so nothing reaches the card. Because
there is no backing store, a genuinely full zram still ends in an OOM kill and
a systemd restart, exactly as with no swap at all.

This is deliberately not zswap. zswap is a compressed cache *in front of* a
real swap device: it needs a swapfile or partition to exist, and it writes back
to that device once its pool fills. On a Pi with disk swap removed it does
nothing, and enabling one to feed it would put the card back in the path.

Two kernel defaults are tuned alongside it in
`/etc/sysctl.d/60-smartamp-zram.conf`: `vm.swappiness` goes up to 150, because
reclaiming an anonymous page now costs a decompress instead of a card read and
is cheaper than evicting page cache that would have to be re-read; and
`vm.page-cluster` goes to 0, so a fault stops reading eight pages ahead — pure
added latency when the swap device has no seek cost. Turning the flag off
removes the generator, its configuration, and this file, and puts both sysctls
back to their stock values.

`smartamp-doctor` reports available memory and whether zram is actually swapped
on, which is the number to watch when moving to a board with less RAM. A Pi
Zero 2 W's 512MB is the tightest this stack runs in, and the one board where
turning zram off is likely to end in an OOM kill.

## Power

`smartamp_power_off_on_halt: true` sets `POWER_OFF_ON_HALT` in the bootloader EEPROM, so halting the board drops its
rails rather than leaving them energised. Because the whole stack is fed from one 20V brick through the AAmp60, that
takes the amplifier's roughly 2W quiescent draw down with the Pi: `sudo poweroff` measures at about 0W at the wall,
with no need to cut the plug to reach that floor.

The trade-off is waking it again. A halted board is not reachable over the network, so only the dedicated power button,
an RTC wakealarm, or a plug power-cycle boots it — plan any away-from-home automation around that before turning the
flag on. A Pi 4B has no such button, and cannot substitute `smartamp_wake_on_gpio` for one while keeping the floor: see
below. At near-zero load the brick's capacitors also hold the rail for a
surprisingly long time, so a plug cut has to
last **at least 60 seconds** before switching back on, or the Pi never sees the gap. Cutting the plug shortly after the
shutdown completes and simply switching it on at arrival avoids the problem entirely — which is what
`smartamp_wait_for_power_button: false` protects. Its EEPROM key, `WAIT_FOR_POWER_BUTTON`, exists on flagship models
since the Pi 5 only and does anything only when `POWER_OFF_ON_HALT` is set (preflight rejects both combinations that
would make it a lie): turn it on and the first boot after power
was removed halts immediately and waits for the dedicated power button, so restoring the plug would no longer wake the
amp on its own. Left off, power coming back is a normal boot.

`smartamp_wake_on_gpio: false` pins `WAKE_ON_GPIO`, which chooses whether a halted board can be woken by pulling GPIO3
or GLOBAL_EN to ground. Raspberry Pi document it as *not relevant* from the Pi 5 onwards, because the dedicated power
button wakes the board from HALT or STANDBY whatever the setting says, and `POWER_OFF_ON_HALT` needs no help from it
there. On a Pi 5 it is therefore managed purely so a re-flashed EEPROM cannot come back with a different value;
changing it will not alter how that board wakes.

On a Pi 4B the two flags are **mutually exclusive**: that bootloader ignores `POWER_OFF_ON_HALT` whenever
`WAKE_ON_GPIO` is set, because watching GPIO3 means leaving the PMIC partly up. Setting both does not get you a wake
path *and* the floor — it gets you the wake path and a halt that quietly does nothing, which reads at the wall as a
powered-off amp still drawing a couple of watts. Preflight refuses the pair
(`wake_on_gpio_defeats_halt` in `boards.yml`). Leave `smartamp_wake_on_gpio` off there and start the board with a plug
cycle, which is what the deep-sleep routine does anyway; turn it on only if a wire to GPIO3 matters more than the
halted draw.

Bootloader settings are applied together in one staged EEPROM update (`ansible/roles/smartamp/tasks/eeprom.yml`) that
the firmware flashes during the reboot provisioning schedules; `PSU_MAX_CURRENT` is the fourth key this role owns on a
Pi 5. Which keys exist is a property of the board (`ansible/roles/smartamp/vars/boards.yml`): a Pi 4B firmware has
neither `WAIT_FOR_POWER_BUTTON` nor `PSU_MAX_CURRENT`, so those are neither written nor stripped there. Keys set by
hand outside the board's list are carried through untouched. Check the live values with `sudo rpi-eeprom-config`.

A Pi Zero 2 W has no bootloader EEPROM to update. A BCM2710 boots `bootcode.bin` from the card, so there is no
`rpi-eeprom-config` to read and no key to write: the board's list is empty, the whole task is skipped, and every one of
the three flags above must be false — preflight names whichever is on rather than dropping it silently. Halting there
leaves the rails energised, so `sudo poweroff` reaches the board's own small idle draw plus the AAmp60's ~2W rather
than the ~0W a Pi 5 or Pi 4B reaches; cutting the plug is the only way to the floor, and switching it back on is what
boots it again.

`smartamp_wifi_enabled` and `smartamp_bluetooth_enabled` control the on-board radios through the `disable-wifi` and
`disable-bt` boot overlays (`ansible/roles/smartamp/tasks/radios.yml`), which remove the devices entirely — that is
what actually stops their draw, where rfkill or a stopped daemon would leave the silicon powered. Flipping either flag
schedules the same reboot other boot-configuration changes do. WiFi is the larger of the two, roughly 0.2–0.4W, but it
stays on while the amp connects over it: preflight refuses to disable the radio while the Pi's default route is on a
wireless interface, so the sequence for the saving is plug in Ethernet, confirm the connection moved, then turn the
flag off and provision. Bluetooth is off by default — nothing in this stack uses it, and the flag also stops
`bluetoothd` on the running system — and turning it back on (say, for Bluetooth audio streaming) restores the services
and the radio at the next reboot.

HDMI is deliberately not a flag. On a modern headless Pi the HDMI PHY is already powered down when no display is
attached, so forcing it off in boot configuration measures at roughly nothing and would only cost the option of
plugging in a monitor to debug a dead board. (The old ~25mA `tvservice -o` saving belongs to earlier firmware.) For
scale, the remaining floor is the board itself: a Pi 5 idles at about 2.5–3W, a Pi 4B rather less, and the AAmp60 adds
its ~2W quiescent
draw — the idle graph teardown, deck sleep, and the halt behaviour above are the levers for those.

## Voice

`voice_assistant_version` pins the upstream release tag that is checked out,
exactly as `sendspin_version` pins the Sendspin client. `make update-versions`
refreshes both to the latest release, along with the pinned `xvf_host`
commit and checksums generated into the role's `vars/main.yml` (that upstream
publishes no releases); review the diff, run `make test`, then provision to
roll the Pi forward. The upstream setup script installs its declared Python dependencies into
`/opt/smartamp/linux-voice-assistant/.venv`; no container runtime is used.
`voice_assistant_wake_model` defaults to `okay_nabu`. Custom OpenWakeWord model
files can be placed in `/var/lib/smartamp/lva/wakewords` and selected by name.
The remote Home Assistant Assist pipeline supplies speech-to-text,
conversation handling, and text-to-speech.

`voice_assistant_stop_model` is the word that abandons what the assistant is
doing, recognised on the Pi rather than in the pipeline, so it lands whether or
not Home Assistant is quick or reachable. Say it while the amp is talking, while
it is waiting on Home Assistant, or over a ringing timer, and the reply stops
mid-word, the request is withdrawn, and the ring blips green. Which of those
phases it is listened for over is compiled into the launcher adapter rather than
configured; the one phase deliberately left out is listening, because the words
being listened for are the request itself and "stop the music" would cancel the
request instead of running it. Its sensitivity is Home Assistant's **Stop Word
Sensitivity** number on the satellite device — lower it if a shouted stop is
missed, raise it if conversation trips it — and the same adapter is what makes
that setting survive a restart.

### Deciding you have finished talking

Left to itself, Home Assistant ends a request after one fixed run of silence,
chosen by the **Finished speaking detection** select on the satellite device.
One figure has to serve both "turn on the lamp" and a sentence with a pause in
the middle of it, so it is either slow or it cuts you off. The launcher adapter
scores the microphone locally instead and closes the speech-to-text stream
itself when the request sounds complete, which is a different thing from the
stop word above: the pipeline runs on and answers, rather than being abandoned.

Home Assistant is still the backstop for every turn the Pi declines to end, so
set that select to **relaxed** once this is on and let the Pi lead. Four
settings shape the decision:

- `voice_assistant_endpoint_silence_ms` (default `250`) — the silence that ends
  a request the Pi is confident about. Set it to `0` to switch local
  endpointing off entirely and hand the decision back to Home Assistant, in
  which case put that select back to default or aggressive.
- `voice_assistant_endpoint_patient_silence_ms` (default `800`) — used instead
  when you stopped after a word shorter than the phrase length below, which is
  what trailing off mid-sentence sounds like.
- `voice_assistant_endpoint_short_phrase_ms` (default `250`) — how long that
  final run of speech has to be to count as a finished phrase. Raising it makes
  more endings count as hesitant, which is a slower amp, not a safer one.
- `voice_assistant_endpoint_min_speech_ms` (default `300`) — speech that must
  have been heard before the Pi may end a turn at all, so a cough or a slammed
  door is left to Home Assistant rather than sent as a request. A two-word
  command is only around half a second of speech, so raising this much drops
  short commands back onto Home Assistant's timing.

Both decisions are logged with `voice_assistant_debug: true`: `Ended the turn
locally` when the Pi called it, and `Home Assistant ended the turn first` with
the figure it was still waiting for when it did not.

The detector itself is `pymicro-vad`, pinned by `voice_assistant_vad_version`
and installed into the satellite's virtual environment. If it is ever missing
the adapter says so once in the journal and leaves the timing to Home Assistant.

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
Which face each voice state shows is compiled into the controller and edited in
`apps/controller/src/voice/led-states.mts`, exactly as the deck layout is: one
line per state, so restyling the ring is an edit and a redeploy rather than an
inventory change.

```ts
thinking: new Spin('#7c4dff'),
listening: new ListenWave('#001018', '#0066ff', '#9df6ff'),
```

Each face is a class in `apps/controller/src/voice/leds/`, one per file, exactly
as a tile or a dial is. It draws itself: given the moment and the live levels,
it answers with the colour of every LED. Nothing maps a description of a face
onto a frame in between, so a new effect is a new class and a new line in the
state map, with nothing else to touch.

```ts
export class Spin implements LedAnimation {
    get framePeriodMs(): number { return this.periodMs / LED_COUNT }

    ring(nowMs: number): readonly number[] { … }
}
```

An animation declares `framePeriodMs` when it needs redrawing, and `demand` when
it paints from live audio, which is what stops the microphone array being read
or the voice bus being metered for a face that is not showing.

The ring is also the quickest sign that the Pi is still booting: it lights well
before the Stream Deck is painted, and long before the voice assistant finishes
waiting for the audio graph. So a voice socket that has never connected shows
`starting` — an amber spinner — rather than the red `disconnected` pulse, which
is held back for 90 seconds or until the socket first answers, whichever comes
first. Stopping the controller darkens the ring and resets the deck to its
firmware logo, so neither surface can leave a state showing for a daemon that is
no longer running.

| Face                          | What the ring shows                                                                                     |
|-------------------------------|---------------------------------------------------------------------------------------------------------|
| `Dark`                        | Every LED off.                                                                                          |
| `Solid(color)`                | One steady colour.                                                                                      |
| `Pulse(color)`                | The colour breathing, swelling and fading without ever reaching black.                                  |
| `Spin(color)`                 | Two LEDs facing each other, travelling round the ring behind fading tails. `periodMs` sets one turn.    |
| `Blink(color)`                | The whole ring flashing on and off.                                                                     |
| `ListenWave(base, ripple, marker)` | The LED facing whoever is speaking, held dim in the marker colour and brightened by their voice, with ripples running outwards from it in their own. |
| `SpeechPulse(color)`          | The whole ring swelling with the assistant's own speech, metered off the voice bus.                     |
| `Flash(color, startedAt)`     | The whole ring lit once and faded out, from the instant it was asked for.                               |

The firmware's own effects — breathing, rainbow, solid, and direction of arrival
— are no longer used. They cannot be driven from live audio, and mixing them with
frames drawn here meant two ways of saying what the ring should look like. The
controller now streams per-LED frames for every face, and asks the firmware for
nothing but `Ring` and `Off`.

`ListenWave` and `SpeechPulse` are the two that follow live audio. The first
reads the XVF3800's own DSP over the same USB control protocol the LEDs use, so
it needs nothing but the array. The LED facing the speaker never falls back to
the ring's own floor, so the array keeps pointing at whoever last spoke through
the gaps between their words, and their voice brightens it the rest of the way.
It carries its own colour too, a pale cyan against the ripples' blue, so the
direction reads as a different light rather than a brighter one; with nobody
placed there is no origin to travel from, so the whole ring answers the level in
the ripples' colour instead. The second needs a level the device cannot
report, so the controller asks the audio manager to meter the voice bus for as
long as that state is showing; with the manager unreachable the ring still
paints, holding a dim steady face instead of a pulse.

One face is shown for a moment rather than for a state: the ring blips green as
a conversation ends. Linux Voice Assistant answers a reply it means to follow up
with `listening` and one it is finished with with `idle`, so reaching idle from a
reply is what says the exchange is over — a continued conversation is never
signed off. Being a moment, it is asked for with the instant it began
(`conversationEndedFace` in `led-states.mts`) rather than sitting in the state
map, and any event arriving mid-blip ends it.

The ring is purely reactive: it renders the configured appearance for the
current voice, media, timer, mute, or error state and nothing else. There is
no separately controllable lamp mode, no persisted LED state, and no Home
Assistant light entity.

Feature flags are reversible: disabling voice, Sendspin, USB gadget audio,
or every controller consumer stops the relevant service and removes its
installed runtime artifacts. Persistent preferences and downloaded wake-word
models under `/var/lib/smartamp` are retained for a later re-enable.

## Stream Deck+

`streamdeck_enabled` turns the control surface on or off for one unit, in its
`host_vars` file. It is off by default — an LED-only amp with no deck attached
is the plainer build — and `office-amp` is the one that turns it on.

The deck is an addon rather than a part of the controller that happens to be
idle. `index.mts` reaches it through one dynamic import of
`streamdeck/control-surface.mts`, taken only when the flag is on, and that
subsystem is the only thing that pulls in the drawing canvas
(`@napi-rs/canvas`), the deck libraries (`@elgato-stream-deck/node`), and the
native JPEG encoder (`@julusian/jpeg-turbo`). Those three are the manifest's
`optionalDependencies`, so with the flag off provisioning installs with
`--omit=optional`, deploys neither `streamdeck/` nor `remote/` nor the bundled
font, and an already-provisioned Pi has all of it removed on the next run —
roughly 46MB of native code, and none of it loaded at startup. Turning the flag
back on restores it. What remains is the part that never needed a deck: the LED
ring, voice ducking, the audio-manager socket, and the Home Assistant client.

Remote tiles require the deck (see below), because what they push are keys.

The key and dial layout, and the panel brightness, are defined in the
controller itself at `apps/controller/src/streamdeck/layout.mts`, not in the
inventory — edit that file and run `make deploy-controller`. Every available
action, with examples and the key feedback each one produces, is listed in
[controls](controls.md). A mistyped `route`/`volume` command is a compile
error, and `make test` rejects any action the catalog does not understand.

### Home Assistant

`home_assistant_url` connects the controller to Home
Assistant's WebSocket API. Because everything it feeds is a deck face, a unit
with no deck empties it in `host_vars` rather than holding open a connection
nothing reads and requiring a token for it; Assist is unaffected, since the
voice satellite connects to Home Assistant on its own. This is what the keys that *show* house state need —
the fan, blinds, PC, scenes, temperature, weather, the lights dial, and
the media transport — because they read entity state as well as change it. It
also carries the assistant timers the TIMER key starts and cancels, which are
intents rather than entities (see [controls](controls.md#timers)). The
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
page leaves the deck with it. It also requires `streamdeck_enabled`: what it
serves are deck keys, so with no deck the listener would authenticate a pushed
face and paint it nowhere. Preflight refuses the combination by name, and the
controller refuses it again from `controller.json`.

### Secrets

The two tokens are the only settings that live in neither `all.yml` nor a unit's
`host_vars`. They are typed on each Pi that needs them, in that unit's
`/etc/smartamp/secrets.env` — an amp with no deck and no Home Assistant URL
needs no such file at all:

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
