# Troubleshooting

Start with:

```sh
sudo smartamp-doctor
```

The command exits non-zero when required hardware, an enabled service, or an
enabled audio path is unavailable. Power-throttle history remains a warning so
you can distinguish a past transient from a currently broken endpoint. It
reports only what that unit is configured for, so a deck-less amp is not asked
about a deck.

From the control computer, `make doctor` runs it on every amp at once, or
`make doctor LIMIT=kitchen-amp` on one. The examples below use `office-amp`;
substitute the unit you are chasing.

## Reading logs

Everything logs to the systemd journal. There are no log files to `tail`.

```sh
sudo journalctl -b -u smartamp-controller       # everything since power-on
sudo journalctl -u smartamp-controller -f       # follow live from now
sudo journalctl -b -u smartamp-controller -f    # replay this boot, then follow
```

`-b` replays the whole boot, so it is never too late to look: run it minutes
after the problem and the startup lines are still there. Only `-f` on its own
starts at "now" and misses startup.

The other units are `smartamp-audio-manager`, `smartamp-voice-assistant`,
`smartamp-sendspin`, `smartamp-audio-inputs`, and `smartamp-usb-audio-gadget`.

The controller is deployed as three bundles rather than one module per source
file, so a raw stack trace would name a line in `index.mjs` and tell you nothing.
Their source maps are deployed beside them and the unit runs Node with
`--enable-source-maps`, so traces in the journal name the original `.mts` file
and line. If you ever need the unbundled equivalent to read alongside, it is
`apps/controller/dist/src/` on the control computer after `make build`.

From the control computer, straight over SSH:

```sh
ssh office-amp.local sudo journalctl -b -u smartamp-controller -f
```

To save a copy off the Pi:

```sh
ssh office-amp.local sudo journalctl -b -u smartamp-controller --no-pager > controller.log
```

One caveat: `smartamp_journal_in_ram` (in
`/etc/systemd/journald.conf.d/smartamp.conf`) decides whether the journal
survives a reboot:

- `false` — on the SD card, capped at 64M, survives reboots.
- `true` — in RAM, capped at 32M, wiped at reboot; capture logs before
  rebooting, or set it to `false` and re-provision while debugging.

The audio manager's live state is not a log: it is a JSON snapshot at
`/run/user/*/smartamp-audio-status.json`, which is RAM-backed and rewritten
continuously.

## HiFiBerry is missing

Confirm `/boot/firmware/config.txt` contains `force_eeprom_read=0`, `dtparam=audio=off`, and the overlay for the board
named in `hifiberry_board` — `dtoverlay=hifiberry-dacplusadcpro` for a DAC2 ADC Pro, `dtoverlay=hifiberry-amp100` for an
Amp100 (with `,auto_mute` appended when `hifiberry_auto_mute` is on). The board needs the kernel overlay rather than the
older overlay embedded in the HAT EEPROM. Both enumerate as the same ALSA card id, `sndrpihifiberry`, so after a reboot
the card name alone will not tell you which overlay actually loaded; `dmesg | grep -i hifiberry` and whether
`arecord -l` lists the card will. An Amp100 has no ADC, so a capture device appearing there means the wrong overlay
loaded.

## Voice hears the speaker output, or cannot hear over music

The XVF3800's acoustic echo cancellation requires the far-end playback reference. The audio manager mirrors the
HiFiBerry output monitor into the XVF3800 USB playback endpoint for this purpose, and pins that whole path — the
XVF3800 playback sink and the reference bridge stream — at 100% and unmuted while active. Check `aec_reference` in
`/run/user/*/smartamp-audio-status.json`: `endpoints_available` means the sink and output monitor exist; `available`
also requires a published reference stream with its gain and mute applied. Neither measures acoustic cancellation.
An idle graph deliberately has no reference stream, which the doctor now treats as expected.

The XVF3800 uses only the left playback channel as its reference. The current stereo loopback therefore needs a
left-only/right-only coverage test before blaming wake-word sensitivity. Read the
[AEC action checklist](audio-reliability-actions.md#aec-and-microphone-validation) before changing routing or gains.

`AEC_AECCONVERGED` is latched: 1 records an earlier convergence, not proof that today's path, level or timing is
correct. A 0 is not specific to timing either. Use the flag alongside controlled reference/microphone recordings,
as described in the [XMOS tuning guide](https://www.xmos.com/documentation/XM-014888-PC/html/modules/fwk_xvf/doc/user_guide/04_tuning_the_application.html).

Start with read-only parameter checks:

```sh
sudo xvf_host VERSION                    # confirms the device responds
sudo xvf_host AUDIO_MGR_SYS_DELAY        # read the current system delay, in 16 kHz samples
sudo xvf_host AEC_AECCONVERGED           # historical convergence, not a live health verdict
sudo xvf_host AUDIO_MGR_REF_GAIN         # far-end reference gain
```

Do not stream full-scale `/dev/urandom` into the default sink. Use a bounded, attenuated stimulus through an explicitly
selected, verified bus; direct playback can precede the manager's gain correction. Delay or gain writes are volatile,
but can still degrade cancellation or cause loud output. Do **not** run
`save_configuration` to persist them: on this firmware it can stop the device enumerating over USB outside safe mode
([upstream issue #8](https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/issues/8)). Before measuring
anything more elaborate, read the measurement traps in [the XVF3800 guide](xvf3800.md#measurement-traps): correlating
PipeWire captures against each other measures capture latency the DSP never sees, and has produced a wrong "aligned"
loopback latency before.

Do not enable LVA's software gain/noise processing until the hardware DSP path is confirmed.

## It does not wake over music

A convergence flag cannot rule out echo leakage. First verify the ASR mux, reference coverage, clipping and microphone
placement. The previous office-amp level measurements in [the XVF3800 guide](xvf3800.md#wake-word-over-music) are
historical observations, not universal wake thresholds. Once cancellation is measured, compare gain and sensitivity
changes against repeatable wake/miss/false-wake results. Leave software noise processing unchanged during that baseline.

To hear what the model hears, record both capture channels and listen on headphones — left ear is the Conference
stream, right ear the ASR stream the assistant actually gets:

```sh
sudo -u smartamp XDG_RUNTIME_DIR=/run/user/$(id -u smartamp) timeout 15 \
  parecord --device=smartamp_voice_input \
  --channels=2 --file-format=wav /tmp/mic.wav
```

## The ReSpeaker Lite's LED is dark

By design. The Lite's USB firmware releases its WS2812 at boot and offers no control interface over USB, so the Pi
cannot light it; `respeaker_led_enabled` is off on such a unit and the deck carries the voice state. The same absence
of a control path means there is no `xvf_host` on a Lite unit and no convergence flag to read: judge its echo
cancellation by recording both capture channels under noise and comparing them, as [respeaker-lite](respeaker-lite.md)
describes.

## Stopping the audio manager stops voice and music too

`smartamp-sendspin` and `smartamp-voice-assistant` declare `Requires=smartamp-audio-manager.service`, so stopping the
audio manager silently stops both, and starting it again does not bring them back. Music Assistant then needs the
Sendspin player re-selected. After any `systemctl stop` or `restart` of the audio manager:

```sh
sudo systemctl start smartamp-sendspin smartamp-voice-assistant
```

## Saying "stop" does not stop it

"Stop" is heard on the Pi and abandons a reply, a wait on Home Assistant, or a ringing timer — it is deliberately not
listened for while the assistant is listening to you, so it cannot cancel a request like "stop the music". If it is
missed in the phases it does cover, watch for `Stop word detected` with `voice_assistant_debug: true`, and lower **Stop
Word Sensitivity** on the satellite device in Home Assistant. A stop missed only while the amp is talking is an echo
problem, not a sensitivity one: the assistant's own voice is what the DSP has to cancel, so work through the AEC section
above first.

## It cuts me off, or waits too long before answering

The Pi decides you have finished and closes the request itself; Home Assistant's
**Finished speaking detection** select is only the backstop, and should be set
to relaxed. With `voice_assistant_debug: true` each local decision logs as
`Ended the turn locally`, with the silence it waited and the speech it heard.

If it cuts you off mid-sentence, raise `voice_assistant_endpoint_silence_ms`, or
raise `voice_assistant_endpoint_short_phrase_ms` so more endings count as
hesitant and get the patient wait.

If it is slow, read which of the two lines appears. `Home Assistant ended the
turn first` names the figure the Pi was still waiting for: a large "needed"
means the turn was judged hesitant, so lower `short_phrase_ms`, and a small
speech total means it never cleared `min_speech_ms`. Neither line at all means
the adapter is not running — check for `No local voice detector installed` at
startup, and that the unit carries the `SMARTAMP_ENDPOINT_` environment. That
case is worth catching quickly, because **relaxed** on the Home Assistant select
is slower than the default the amp had before local endpointing existed.

Time after the ring stops listening belongs to the other machine, not the
endpointer: the spinner starts when Home Assistant reaches the intent, so
speech-to-text sits between the two. The pipeline debug view (Settings → Voice
assistants → ⋮ → Debug) times each stage. Setting the silence to `0` disables
local endpointing entirely and restores the old behaviour.

## Music does not duck or restore

Check the `music_bus` section in `/run/user/*/smartamp-audio-status.json`. `available` confirms that the music
sink and HiFiBerry bridge exist; `ducked` reports whether any connected controller is currently requesting a duck.
Sendspin should have `PULSE_SINK=smartamp_music` in `systemctl cat smartamp-sendspin`, and an enabled USB route
should target the same sink in `pactl list sink-inputs`.

The controller sends `set-duck` over the audio manager's control socket from LVA events. The manager holds that request
against the controller's connection, so a controller crash or restart releases it immediately and the music
returns to full volume; there is no lease file to inspect or expire. If the gain does not change, check that the
controller is connected to the socket in the `smartamp-controller` log, then look for `Ducked`/`Restored` lines in
`smartamp-audio-manager`.

## Music Assistant's volume does nothing, or fights the dial

Music Assistant's slider for this player is the music bus sink's own volume, which the audio manager mirrors onto the
music level and back. Confirm the wiring first — the client must be on the PulseAudio volume backend, and the bus must
be the default sink it resolves to:

```sh
systemctl cat smartamp-sendspin | grep -E 'hardware-volume|PULSE_SINK'
journalctl -u smartamp-sendspin | grep -iE 'hardware volume|volume changed externally' | tail
sudo -u smartamp XDG_RUNTIME_DIR=/run/user/$(id -u smartamp) pactl get-default-sink
```

The default sink must be `smartamp_music`. If it is the HiFiBerry, the client is watching the pinned output
instead and will fight the manager's 100% pin; check for `Pinned the output sink` repeating in
`smartamp-audio-manager`.

Then watch the register and the level move together. Turn the deck's dial and Music Assistant should follow; move the
slider and the level should follow:

```sh
sudo -u smartamp XDG_RUNTIME_DIR=/run/user/$(id -u smartamp) \
  pactl list sinks | grep -A 8 smartamp_music
jq '{music_bus, output_volume, sources}' /run/user/*/smartamp-audio-status.json
journalctl -u smartamp-audio-manager | grep -E 'Music volume set to' | tail
```

`Music volume set to N% on the bus` is the manager adopting a change something else made. If the two nudge each other
back and forth instead of settling, the agreement is being dropped every pass — look for the sink quantising the value
it was written, which the register re-reads specifically to avoid.

If music plays much quieter than the level says, the bus's monitor is attenuating as well as its bridge. The sink is
created with `monitor.channel-volumes=false` to prevent exactly that; confirm it survived:

```sh
sudo -u smartamp XDG_RUNTIME_DIR=/run/user/$(id -u smartamp) \
  pactl list sinks | grep -B 20 smartamp_music | grep -i monitor.channel-volumes
```

## Music crackles or pops every few seconds

Steady, quiet crackling through the speakers — with `vcgencmd get_throttled` reading `0x0` and low CPU load — is the
audio graph missing its cycle deadline. Confirm it by watching the xrun counter climb on the HiFiBerry nodes:

```sh
sudo -u smartamp XDG_RUNTIME_DIR=/run/user/$(id -u smartamp) pw-top   # ERR column on the soc_sound nodes
```

A rising ERR count with `BUSY` times far below the quantum means scheduling, not CPU. PipeWire's processing loop must
run realtime; check its class:

```sh
ps -eLo tid,user,cls,rtprio,comm | grep data-loop   # FF 88 is healthy, TS - is the fault
```

Every `data-loop` matters, not only PipeWire's own: the `pw-loopback` children of `smartamp-audio-inputs` carry the
aux and USB audio into the bus and get their grant from that unit's own `LimitRTPRIO`. An amp that is clean on
Sendspin but snaps every minute or so on the USB input, and distorts while the volume dial turns, is those threads
timeshared while the dial's burst of `pactl` calls preempts them; the ERR column then climbs on the gadget's
`alsa_input.platform-…usb` node and the `smartamp_input_usb…_capture` stream first.

`TS` means the thread could not take SCHED_FIFO. Provisioning installs
`/etc/systemd/system/user@<uid>.service.d/realtime.conf` raising `LimitRTPRIO` and `LimitNICE` and setting
`DISABLE_RTKIT=1`; re-provision if it is missing, and restart the session
(`sudo systemctl restart user@$(id -u smartamp)`) after changing it. All three lines matter: rtkit itself refuses
users without an active logind session (which a lingering service account never has), and PipeWire's module-rt wants
nice -11 as well as SCHED_FIFO — if either rlimit blocks it, it silently demotes the loop and routes the whole
request over D-Bus to that dead end. With the drop-in in place a failure is loud: `journalctl` shows `mod.rt`
saying exactly what it could not do.

Crackling that only happens while someone is SSH'd into the Pi is the other classic: each login used to start a second
PipeWire under the admin user that busy-spun against the missing session infrastructure. Provisioning masks the
PipeWire user units for the admin account; `pgrep -au matt pipewire` should find nothing.

## A rare loud pop from the speakers

A single loud pop out of nowhere — not the steady crackle above — is a full-scale transient reaching the amplifier: a
stream connecting in the instant before the audio manager lands its gain, a DC step from a bridge being loaded or
unloaded, or driver garbage during a graph rebuild. The backstop is the DAC's hardware ceiling,
`hifiberry_output_volume_percent` (default 90, about −10 dB): it sits below everything PipeWire does, so it caps every
one of those cases at once. Confirm it is actually holding — WirePlumber must not be managing the same control:

```sh
amixer -c sndrpihifiberry sget Digital        # both values should read the boot value, or where AMP CEILING left it
grep -r soft-mixer /etc/wireplumber/          # the smartamp rule keeping PipeWire volume in software
```

If `Digital` reads 100% and nobody raised it from the deck's `AMP CEILING` key, PipeWire has folded the pinned sink
volume back into the hardware control — re-provision so the soft-mixer rule above is installed, and restart the
session. `smartamp-doctor` makes the same check, and warns rather than fails at 100% because it cannot tell the two
apart; a reboot puts the inventory value back either way. The rule has to match the ALSA *card*
(`alsa_card.platform-…`), because `api.alsa.soft-mixer` is
a device property: an earlier version matched the output node instead, which WirePlumber ignores without a word, and
would have left the amp playing about 10 dB above its ceiling with no cap on transients. Read `Digital` back on each
unit after re-provisioning to confirm.

A related symptom is an amp that comes up silent after the audio manager restarts. Its temporary rebuild guard uses
an ordinary sink mute, which WirePlumber persists. Nothing else is meant to mute the sink — the deck's volume mute is
a gain on the music paths — so the manager treats any mute it finds as an abandoned guard and releases it once playback
gains settle; a failed unmute keeps the guard held for retry. If the output stays silent, check the deck's volume
reading first (`MUTED` means the volume mute, and a press of the dial ends it; a computer on the USB port can set it
with its mute key too), then the journal for repeated gain or mute failures. Hard
reconciliation failures remove readiness status, so a missing status file can also indicate active recovery rather
than a stopped manager.

To catch the culprit rather than just cap it, note the clock time of the next pop and read what the graph was doing:

```sh
journalctl -u smartamp-audio-manager --since "10 min ago" -o short-precise
```

A pop that lines up with `releasing the idle bridges` or `Rebuilding the idle bridges` is the idle teardown
(`smartamp_idle_teardown_seconds`, default 180) — set it to `0` for a day to confirm, at the cost of about a watt of
standing draw. A rebuild is meant to be silent: the journal should show `Found the music playback bridge stream at
0%` and then `Faded the music bridge in`; a bridge found at `100%` means PipeWire ignored the silent-start property
and the guard alone caught it, and a pop on the `Faded` line with the bridge found at 0% is the DAC itself waking. A pop that lines up with `Holding client stream` is a client that connected loud before the manager
caught it; the ceiling is the intended protection for that race.

## USB audio device does not appear on the computer

The cable must be connected to the Pi's USB-C port, not a USB-A port. On a Pi 4B it must also be a cable with the power
line cut: that board wires USB-C VBUS onto the same 5V rail the AAmp60 feeds through the GPIO header, with no PMIC
between them. A Pi Zero 2 W cannot do this at all — its one data port is already hosting the deck and the ReSpeaker —
and provisioning refuses `usb_audio_gadget_enabled` there, so the deck's USB key draws greyed. Work down the chain on
the Pi:

```sh
systemctl status smartamp-usb-audio-gadget   # the gadget was assembled and bound
ls /sys/class/udc                            # dwc2 probed a device controller
cat /sys/class/udc/*/state                   # "configured" once the computer enumerates it
dmesg | grep -iE 'dwc2|gadget'               # controller mode and enumeration attempts
```

If `/sys/class/udc` is empty, confirm `dtoverlay=dwc2,dr_mode=peripheral` survived in `/boot/firmware/config.txt` and
reboot. If the state never leaves `not attached` while the computer reports only a charging or power event, the data
pairs are not connecting: try a different USB-C cable (charge-only and some e-marked cables fail here) and the
computer's other ports.

A Mac connected directly with a C-to-C cable may settle into a pure power relationship — it supplies 5V (visible as
`EXT5V_V` in `vcgencmd pmic_read_adc`) but never takes the USB host role, so the state stays `not attached` with any
cable. The likely cause is the Pi's VBUS backfeed described below, so try a charge-blocking adapter first; failing
that, connecting the Pi through a USB-C dock or hub forces the Mac into host mode and it enumerates immediately.
Setting `PSU_MAX_CURRENT` in the bootloader EEPROM does not change this — it was tested and the Mac still refused the
direct connection.

The state file is only reliable in the attach direction: with the VBUS-blocking adapter in place the controller never
sees the session drop, so it keeps reading `configured` after an unplug until the next replug. The live signal is the
gadget card's rate control, which reads the negotiated rate while the computer is actually streaming and `0` when it
is idle, playing to another output, or gone:

```sh
amixer -c UAC2Gadget cget iface=PCM,name='Capture Rate'   # values=48000 streaming, values=0 idle or unplugged
```

The audio inputs app gates its USB loopback on that control, and the Stream Deck's USB icon is the audio manager
seeing that loopback's stream on the bus, so both follow actual playback rather than enumeration.

If the computer is playing but no sound arrives, check `journalctl -u smartamp-audio-inputs` and
`/run/user/<smartamp UID>/smartamp-audio-inputs-status.json`: under `inputs.usb`, `streaming` should be true, `node`
should name the gadget's capture node, and `playing` should be true once the loopback stream has reached the graph.
Then check the manager's `smartamp-audio-status.json`: `sources.usb.available` should be true and `enabled` is the
deck's toggle — a switched-off source plays at silence, so a stream that is there but inaudible is usually the toggle.
The inputs app activates the gadget card's pro-audio profile itself when the card is parked off; an older deployment
without that logic needs `pactl set-card-profile alsa_card.platform-1000480000.usb pro-audio` once.

Because the Pi is powered through GPIO, its 5V rail sits directly on the USB-C VBUS pin — there is no switch firmware
could open — so the Pi backfeeds power into whatever it is plugged into. A connected laptop may report it is charging
(slowly) from the Pi, an unpowered dock boots up from the Pi alone, and a host port seeing unexpected VBUS can decide
the Pi is a charger rather than a device (the likely reason a directly attached Mac refuses the data-host role). The
backfeed also makes dock connections order-sensitive: a dock plugged into the Pi first latches the Pi as its power
source and never routes the port when the computer arrives later, so connect dock to computer first and the Pi last.

A USB-C charge/VBUS-blocking adapter on the Pi's cable fixes the backfeed properly (confirmed working): data passes,
no power crosses in either direction, and the Pi does not need incoming VBUS because its gadget controller has no
VBUS sensing. With the blocker in place the dock no longer powers on from the Pi and plug order stops mattering. The
USB-C port cannot simultaneously be the normal dedicated PSU connection in gadget mode; the HiFiBerry/AAmp60 stack
powers the Pi through GPIO.

## macOS names the USB device "Playback Inactive"

macOS labels a USB audio device with its AudioStreaming interface string, and the kernel's UAC2 gadget driver
hardcodes that one to "Playback Inactive" — it is not among the strings configfs exposes, so `usb_audio_product`
cannot reach it. Cosmetic only; Windows and Linux name the device from the product string and show it correctly.

## USB audio plays but sounds like an old radio

Loud static with the music faintly underneath means the sample format, not the route: the dwc2 gadget controller
corrupts 3-byte (24-bit) samples on its isochronous endpoints. Keep `usb_audio_sample_size_bytes: 2` in
inventory (16-bit is the tested, clean configuration) and re-provision; the gadget descriptors only change on a
reboot, which provisioning schedules automatically.

## USB devices disconnect or LEDs flicker

Run `vcgencmd get_throttled`. Any non-zero under-voltage bits indicate a power problem. Put the ReSpeaker and Stream
Deck+ on a quality powered USB hub, ensure the AAmp60 supply and wiring are appropriately rated, and use active
cooling.

On a Pi 4B a powered hub is the likelier answer from the start: its four USB-A ports share a fixed budget of roughly
1.2A whatever the board is powered from, and there is no bootloader setting to raise it. On a Pi Zero 2 W the hub is
not optional and must be self-powered — a bus-powered one puts the deck and the ReSpeaker back on the Pi's single
micro-USB port, which is where this symptom comes from.

On a Pi 5, provisioning sets `PSU_MAX_CURRENT` in the bootloader EEPROM from `usb_audio_psu_max_current_ma` (check with
`sudo rpi-eeprom-config`). A GPIO-powered Pi has no USB-PD source to negotiate with, so without the setting the
firmware assumes a weak supply, logs a low-power warning, and caps the USB-A ports at 600mA total. The 3000 mA
default states what the AAmp60's 5V rail realistically provides; do not raise it to 5000 without validating the
stack's power budget. Disabling `usb_audio_gadget_enabled` removes the declaration again so a USB-C PSU negotiates
normally.

## The POWER key arms but nothing happens

The second press runs `systemctl poweroff` — or `systemctl reboot` when the dial
was turned to REBOOT — as the `smartamp` account, which logind only allows
because of the polkit rule provisioning installs. Check the controller log for
`poweroff failed` or `reboot failed` (`journalctl -u smartamp-controller`); an
"Interactive authentication required" message means the rule is missing or
polkitd is not running. Confirm both with
`ls /etc/polkit-1/rules.d/50-smartamp-poweroff.rules` and
`systemctl status polkit`, then re-provision. The key unlatches after a failure,
so it can be pressed again once the permission is in place.

## The Pi does not come back after a shutdown

With `smartamp_power_off_on_halt: true` (the default) the bootloader cuts the board's rails on halt, so a halted Pi
draws nothing and answers nothing — no ping, no SSH, no wake-on-LAN. Boot it with the dedicated power button, an RTC
wakealarm, or by power-cycling the plug. On a Pi 5 `WAKE_ON_GPIO` has no bearing on this: from the Pi 5 onwards the
power button wakes the board from HALT or STANDBY whatever that setting is. A Pi 4B has no power button, and there
`WAKE_ON_GPIO` cannot be the answer: that bootloader ignores `POWER_OFF_ON_HALT` whenever it is set, so provisioning
refuses the two together and a plug cycle is the wake path. None of this applies to a Pi Zero 2 W: it has no
bootloader EEPROM, so the flag must be false there and a
halt leaves the rails up. If such a board is unreachable after a shutdown it has genuinely stopped rather than powered
down, and cutting the plug is what restarts it.

A plug cut has to be long enough. The whole stack sits at roughly 0W once halted, so the 20V brick's capacitors keep
the rail up through a brief interruption: a 10 second off/on does nothing. Leave it off for **at least 60 seconds**, or
switch the plug off shortly after the shutdown finishes so that turning it on is a clean cold start. If the board is up
but you expected it to be off, check `sudo rpi-eeprom-config` for `POWER_OFF_ON_HALT=1` — a hand-flashed or re-imaged
EEPROM loses it, and re-provisioning puts it back.

## A halted Pi 4B still draws a couple of watts

Check the same output for `WAKE_ON_GPIO`:

```sh
sudo rpi-eeprom-config | grep -E 'POWER_OFF_ON_HALT|WAKE_ON_GPIO'
```

`WAKE_ON_GPIO=1` makes the BCM2711 bootloader ignore `POWER_OFF_ON_HALT` altogether, so the halt leaves the rails up
and the board sits at roughly the draw it would if it had never powered down. Both keys set is the combination to look
for; provisioning now refuses it, but an EEPROM flashed before that check went in can still carry it. Set
`smartamp_wake_on_gpio: false` for the unit and re-provision. This is a Pi 4B trait — on a Pi 5 the two are
independent, which is why the same inventory measured near 0W there.

## Stream Deck is dark

Unplug/replug it once after the initial udev rule installation, then check `lsusb | grep 0fd9` and the controller
service log. The Node dependency may compile `node-hid` locally on Raspberry Pi; the playbook installs its compiler and
`libudev` prerequisites.

## Home Assistant does not discover voice

If `smartamp-voice-assistant` reports that audio routing did not become ready,
run `smartamp-doctor`. Its PipeWire section checks the two halves separately:
the status file at `/run/user/*/smartamp-audio-status.json` must name the
output `sink` (check `smartamp-audio-manager` logs for the HiFiBerry match if
not), and `pactl list sources short` as the `smartamp` user must list
`smartamp_voice_input` (the array's capture node, renamed by the WirePlumber
rule in `/etc/wireplumber/wireplumber.conf.d/60-smartamp-voice-input.conf`)
and `smartamp_voice_capture` (the mono ASR source the loopback in
`/etc/pipewire/pipewire.conf.d/60-smartamp-voice-capture.conf` lifts from
it), and `pactl get-default-source` must answer with the latter. The doctor
also looks for the array `respeaker_board` names, by USB id, so a unit
configured for an XVF3800 with a ReSpeaker Lite plugged in (or the reverse)
fails there by name: the two match different node names and want different
capture channels, and neither works under the other's settings.

If the array is plugged in but `smartamp_voice_input` is missing, WirePlumber
did not rename its node: compare the ALSA name in `pactl list sources short`
against the rule's pattern, and check the card is on a profile with an input
(`pactl list cards`), which the rule asks for but a stored profile can
override; `pactl set-card-profile <card> output:analog-stereo+input:analog-stereo`
puts it right. If `smartamp_voice_input` is there but `smartamp_voice_capture`
is not, check that PipeWire still has the loopback loaded: `pw-cli ls Module`
as the `smartamp` user should list `libpipewire-module-loopback`. The loopback
loads when PipeWire starts, before WirePlumber has enumerated the array, and
WirePlumber destroys a stream whose named target is missing unless the stream
also sets `node.linger`; a loopback whose stream is destroyed unloads itself,
so a drop-in without that line leaves no module and no source, with nothing
in the journal at the default log level. If `smartamp_voice_capture` exists
but the assistant hears silence, the loopback is not linked to the node: `pw-link -l` shows whether
`smartamp_voice_capture.input` has a link from `smartamp_voice_input`, and the
node's channel positions (`pactl list sources`, Channel Map) must include the
one the drop-in names, front-left for channel 0 or front-right for channel 1.

Ensure the Pi and Home Assistant share an mDNS-capable LAN/VLAN, and ports 6053/tcp and mDNS are not filtered. Add it
manually through **Settings → Devices & services → ESPHome** using the Pi IP and port 6053 if discovery is blocked.
