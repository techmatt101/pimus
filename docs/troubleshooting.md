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

Confirm `/boot/firmware/config.txt` contains `force_eeprom_read=0`, `dtparam=audio=off`, and
`dtoverlay=hifiberry-dacplusadcpro`. The Pi 5 needs the kernel overlay rather than the older overlay embedded in the HAT
EEPROM. Check `dmesg | grep -i hifiberry` after reboot.

## Voice hears the speaker output

The XVF3800's acoustic echo cancellation requires the far-end playback reference. The audio manager mirrors the
HiFiBerry output monitor into the XVF3800 USB playback endpoint for this purpose. Check the `aec_reference` section in
`/run/user/*/smartamp-audio-status.json`. If it is available but cancellation is poor, tune the XVF3800 system delay and
far-end gain using Seeed's `xvf_host.py`. Do not enable LVA's software gain/noise processing until the hardware DSP path
is confirmed.

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

The cable must be connected to the Pi 5 USB-C port, not a USB-A port. Work down the chain on the Pi:

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

If the state reads `configured` but no sound arrives, check the `smartamp-audio-manager` journal: its reconcile status
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

Loud static with the music faintly underneath means the sample format, not the route: the Pi 5's dwc2 gadget
controller corrupts 3-byte (24-bit) samples on its isochronous endpoints. Keep `usb_audio_sample_size_bytes: 2` in
inventory (16-bit is the tested, clean configuration) and re-provision; the gadget descriptors only change on a
reboot, which provisioning schedules automatically.

## USB devices disconnect or LEDs flicker

Run `vcgencmd get_throttled`. Any non-zero under-voltage bits indicate a power problem. Put the ReSpeaker and Stream
Deck+ on a quality powered USB hub, ensure the AAmp60 supply and wiring are appropriately rated, and use active Pi 5
cooling.

Provisioning sets `PSU_MAX_CURRENT` in the bootloader EEPROM from `usb_audio_psu_max_current_ma` (check with
`sudo rpi-eeprom-config`). A GPIO-powered Pi has no USB-PD source to negotiate with, so without the setting the
firmware assumes a weak supply, logs a low-power warning, and caps the USB-A ports at 600mA total. The 3000 mA
default states what the AAmp60's 5V rail realistically provides; do not raise it to 5000 without validating the
stack's power budget. Disabling `usb_audio_gadget_enabled` removes the declaration again so a USB-C PSU negotiates
normally.

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
