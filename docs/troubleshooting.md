# Troubleshooting

Start with:

```sh
sudo smartamp-doctor
```

The command exits non-zero when required hardware, an enabled service, or an
enabled audio path is unavailable. Power-throttle history remains a warning so
you can distinguish a past transient from a currently broken endpoint.

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
`smartamp-sendspin`, and `smartamp-usb-audio-gadget`.

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
XVF3800 playback sink and the reference bridge stream — at 100% and unmuted on every reconcile, so the DSP receives the
reference at the level the room hears. Check the `aec_reference` section in `/run/user/*/smartamp-audio-status.json`.

To hear the reference itself, plug headphones into the ReSpeaker's speaker jack: it plays exactly the reference
stream, so it should carry the music and follow the volume dial. To inspect it properly, record the reference and the
mic at the same time while music plays and the wake word is spoken (run as the audio user with
`sudo -u smartamp XDG_RUNTIME_DIR=/run/user/$(id -u smartamp) parecord ...`), using the XVF3800 sink's `.monitor` for
the reference and the XVF3800 source for the mic, then compare them: if the music is about as loud in the mic capture
as in the reference, cancellation is doing nothing.

If the reference path is healthy but cancellation is still poor, the usual cause is timing: the reference crosses a
PipeWire loopback (`smartamp_loopback_latency_ms`) and USB before reaching the DSP, while the sound reaches the mics
almost immediately, so the reference can arrive after the echo it is meant to predict. Tune the DSP with the `xvf_host`
tool, installed with the voice assistant and on the PATH:

```sh
sudo xvf_host VERSION                    # confirms the device responds
sudo xvf_host AUDIO_MGR_SYS_DELAY        # read the current system delay
sudo xvf_host AUDIO_MGR_SYS_DELAY 30     # try a larger delay, then test the wake word over music
sudo xvf_host AUDIO_MGR_REF_GAIN         # far-end reference gain
```

Values set this way are volatile and revert at the next power cycle, which makes experimenting safe. Do **not** run
`save_configuration` to persist them: on this firmware it can stop the device enumerating over USB outside safe mode
([upstream issue #8](https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/issues/8)).

Do not enable LVA's software gain/noise processing until the hardware DSP path is confirmed.

## Background audio does not duck or restore

Check the `background` section in `/run/user/*/smartamp-audio-status.json`. `available` confirms that the background
sink and HiFiBerry bridge exist; `ducked` reports whether any connected controller is currently requesting a duck.
Sendspin should have `PULSE_SINK=smartamp_background` in `systemctl cat smartamp-sendspin`, and an enabled USB route
should target the same sink in `pactl list sink-inputs`.

The controller sends `set-duck` over the audio manager's control socket from LVA events. The manager holds that request
against the controller's connection, so a controller crash or restart releases it immediately and background audio
returns to full volume; there is no lease file to inspect or expire. If the gain does not change, check that the
controller is connected to the socket in the `smartamp-controller` log, then look for `Ducked`/`Restored` lines in
`smartamp-audio-manager`.

## USB audio device does not appear on the computer

The cable must be connected to the Pi's USB-C port, not a USB-A port. On a Pi 4B it must also be a cable with the power
line cut: that board wires USB-C VBUS onto the same 5V rail the AAmp60 feeds through the GPIO header, with no PMIC
between them. Work down the chain on the Pi:

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

The audio manager gates the USB bridge and the Stream Deck's usb status icon on that control, so both follow actual
playback rather than enumeration.

If the computer is playing but no sound arrives, check the `smartamp-audio-manager` journal: its reconcile status
should show the `usb` source with `"available": true` and a node name. The manager activates the gadget card's
pro-audio profile itself when the card is parked off; an older deployment without that logic needs
`pactl set-card-profile alsa_card.platform-1000480000.usb pro-audio` once.

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
1.2A whatever the board is powered from, and there is no bootloader setting to raise it.

On a Pi 5, provisioning sets `PSU_MAX_CURRENT` in the bootloader EEPROM from `usb_audio_psu_max_current_ma` (check with
`sudo rpi-eeprom-config`). A GPIO-powered Pi has no USB-PD source to negotiate with, so without the setting the
firmware assumes a weak supply, logs a low-power warning, and caps the USB-A ports at 600mA total. The 3000 mA
default states what the AAmp60's 5V rail realistically provides; do not raise it to 5000 without validating the
stack's power budget. Disabling `usb_audio_gadget_enabled` removes the declaration again so a USB-C PSU negotiates
normally.

## The SHUTDOWN key arms but nothing happens

The second press runs `systemctl poweroff` as the `smartamp` account, which
logind only allows because of the polkit rule provisioning installs. Check the
controller log for `poweroff failed` (`journalctl -u smartamp-controller`); an
"Interactive authentication required" message means the rule is missing or
polkitd is not running. Confirm both with
`ls /etc/polkit-1/rules.d/50-smartamp-poweroff.rules` and
`systemctl status polkit`, then re-provision. The key unlatches after a failure,
so it can be pressed again once the permission is in place.

## The Pi does not come back after a shutdown

With `smartamp_power_off_on_halt: true` (the default) the bootloader cuts the board's rails on halt, so a halted Pi
draws nothing and answers nothing — no ping, no SSH, no wake-on-LAN. Boot it with the dedicated power button, an RTC
wakealarm, or by power-cycling the plug. On a Pi 5 `WAKE_ON_GPIO` has no bearing on this: from the Pi 5 onwards the
power button wakes the board from HALT or STANDBY whatever that setting is. A Pi 4B has no power button, so there
`WAKE_ON_GPIO` is the wake path — shorting GPIO3 or GLOBAL_EN to ground — and provisioning refuses to halt the rails
without it.

A plug cut has to be long enough. The whole stack sits at roughly 0W once halted, so the 20V brick's capacitors keep
the rail up through a brief interruption: a 10 second off/on does nothing. Leave it off for **at least 60 seconds**, or
switch the plug off shortly after the shutdown finishes so that turning it on is a clean cold start. If the board is up
but you expected it to be off, check `sudo rpi-eeprom-config` for `POWER_OFF_ON_HALT=1` — a hand-flashed or re-imaged
EEPROM loses it, and re-provisioning puts it back.

## Stream Deck is dark

Unplug/replug it once after the initial udev rule installation, then check `lsusb | grep 0fd9` and the controller
service log. The Node dependency may compile `node-hid` locally on Raspberry Pi; the playbook installs its compiler and
`libudev` prerequisites.

## Home Assistant does not discover voice

If `smartamp-voice-assistant` reports that audio routing did not become ready,
inspect `/run/user/*/smartamp-audio-status.json`. Both `sink` and `voice_input`
must contain device names. Then check `smartamp-audio-manager` logs for the
HiFiBerry or ReSpeaker match that is missing.

`voice_capture` in the same file shows the ASR-channel remap: `source` should
read `smartamp_voice_capture`, and that source should be the PipeWire default
(`pactl get-default-source`). If `source` is null with a channel configured,
the device's channel map did not contain that channel — the manager logs the
map it saw — and the assistant is hearing the raw device instead, which on the
XVF3800 means a Conference/ASR downmix rather than the ASR stream.

Ensure the Pi and Home Assistant share an mDNS-capable LAN/VLAN, and ports 6053/tcp and mDNS are not filtered. Add it
manually through **Settings → Devices & services → ESPHome** using the Pi IP and port 6053 if discovery is blocked.
