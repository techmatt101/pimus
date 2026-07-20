# Troubleshooting

Start with:

```sh
sudo smartamp-doctor
```

Then inspect a specific service:

```sh
sudo journalctl -b -u smartamp-audio-manager
sudo journalctl -b -u smartamp-voice-assistant
sudo journalctl -b -u smartamp-peripherals
sudo journalctl -b -u smartamp-streamdeck
```

## HiFiBerry is missing

Confirm `/boot/firmware/config.txt` contains `force_eeprom_read=0`, `dtparam=audio=off`, and `dtoverlay=hifiberry-dacplusadcpro`. The Pi 5 needs the kernel overlay rather than the older overlay embedded in the HAT EEPROM. Check `dmesg | grep -i hifiberry` after reboot.

## Voice hears the speaker output

The XVF3800's acoustic echo cancellation requires the far-end playback reference. The audio manager mirrors the HiFiBerry output monitor into the XVF3800 USB playback endpoint for this purpose. Check the `aec_reference` section in `/run/user/*/smartamp-audio-status.json`. If it is available but cancellation is poor, tune the XVF3800 system delay and far-end gain using Seeed's `xvf_host.py`. Do not enable LVA's software gain/noise processing until the hardware DSP path is confirmed.

## USB audio device does not appear on the computer

The cable must be connected to the Pi 5 USB-C port, not a USB-A port. Check `systemctl status smartamp-usb-audio-gadget`, `ls /sys/class/udc`, and confirm `dtoverlay=dwc2,dr_mode=peripheral`. The USB-C port cannot simultaneously be the normal dedicated PSU connection in this mode; the HiFiBerry/AAmp60 stack powers the Pi through GPIO.

## USB devices disconnect or LEDs flicker

Run `vcgencmd get_throttled`. Any non-zero under-voltage bits indicate a power problem. Put the ReSpeaker and Stream Deck+ on a quality powered USB hub, ensure the AAmp60 supply and wiring are appropriately rated, and use active Pi 5 cooling.

## Stream Deck is dark

Unplug/replug it once after the initial udev rule installation, then check `lsusb | grep 0fd9` and the Stream Deck service log. The Node dependency may compile `node-hid` locally on Raspberry Pi; the playbook installs its compiler and `libudev` prerequisites.

## Home Assistant does not discover voice

Ensure the Pi and Home Assistant share an mDNS-capable LAN/VLAN, and ports 6053/tcp and mDNS are not filtered. Add it manually through **Settings → Devices & services → ESPHome** using the Pi IP and port 6053 if discovery is blocked.
