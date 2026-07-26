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

The cable must be connected to the Pi 5 USB-C port, not a USB-A port. Check
`systemctl status smartamp-usb-audio-gadget`, `ls /sys/class/udc`, and confirm `dtoverlay=dwc2,dr_mode=peripheral`. The
USB-C port cannot simultaneously be the normal dedicated PSU connection in this mode; the HiFiBerry/AAmp60 stack powers
the Pi through GPIO.

## USB devices disconnect or LEDs flicker

Run `vcgencmd get_throttled`. Any non-zero under-voltage bits indicate a power problem. Put the ReSpeaker and Stream
Deck+ on a quality powered USB hub, ensure the AAmp60 supply and wiring are appropriately rated, and use active Pi 5
cooling.

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
