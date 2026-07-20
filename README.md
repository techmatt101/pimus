# Pimus Smart Amp

An idempotent Raspberry Pi 5 build recipe for:

- HiFiBerry DAC2 ADC Pro with the AAmp60 add-on amplifier
- ReSpeaker XMOS XVF3800 USB four-microphone array
- Elgato Stream Deck+
- analogue aux input, computer audio over USB-C, Home Assistant media, and Squeezelite
- Home Assistant Assist, local wake word, voice responses, timers, and announcements
- configurable ReSpeaker LEDs and Stream Deck+ keys, dials, and touch strip

The recipe targets a fresh 64-bit Raspberry Pi OS Lite Bookworm or Trixie install. It provisions the Pi over SSH instead of baking credentials into a disk image; running it again produces the same configuration and applies upgrades safely.

A flashable Raspberry Pi OS Trixie image path is also included using Raspberry Pi's official `rpi-image-gen`; see [image building](image/README.md). The SSH provisioning route is faster for the fresh Lite install you already have.

## Read this before powering the stack

The AAmp60 is compatible with the DAC+ ADC Pro family, but its published power guarantee only covers Raspberry Pi models through Pi 4. A Pi 5 can expose up to 1.6 A to USB peripherals only with a 5 A supply; the AAmp60, XVF3800 and Stream Deck+ combination therefore needs power validation. Use `smartamp-doctor` to check the Pi throttle/under-voltage flags, and plan on a powered USB hub if flags appear or USB devices reset.

The optional USB audio input changes the Pi 5 USB-C port into a peripheral port. The Pi must then be powered through the HiFiBerry/AAmp60 GPIO stack. Connect the USB-C port to the source computer; the four USB-A ports remain hosts for the ReSpeaker and Stream Deck+.

## Quick start

On the fresh Pi, use Raspberry Pi Imager to enable SSH and create your normal admin user. From this control computer:

```sh
python3 -m pip install --user ansible
make install
```

Edit [`inventory/hosts.yml`](inventory/hosts.yml) so the hostname/IP and `ansible_user` match the Pi. Review the feature settings in [`inventory/group_vars/all.yml`](inventory/group_vars/all.yml), then run:

```sh
ssh matt@office-amp.local  # accept the new host key, then exit
make provision
```

Boot configuration changes trigger one reboot. When provisioning finishes:

```sh
make doctor
```

In Home Assistant, open **Settings → Devices & services**. The device named **Office Amp Voice** should be discovered by the ESPHome integration. Add it, select the desired Assist pipeline, and enable the LED-ring light entity if you want Home Assistant to override the default voice-state effects.

For Music Assistant, add the Squeezelite player named **Office Amp**. Discovery normally works on the local network; otherwise set `squeezelite_server` to the Music Assistant host IP and provision again.

This project installs no Home Assistant, Music Assistant, or LMS server components. `office-amp` is only a network audio/voice endpoint; the server and media library remain on your other machine.

## Everyday control

The default Stream Deck+ layout is:

| Key | Action |
|---|---|
| Voice | Start an Assist conversation |
| Mic | Toggle voice microphone mute |
| Aux | Toggle analogue input monitoring |
| USB | Toggle computer USB audio monitoring |
| Play | Pause/resume the LVA media player |
| Stop | Stop voice, ringing timer, and LVA media |
| Timer | Dismiss a ringing timer |
| Lights | Cycle voice/off/single/breath/rainbow/DOA modes |

Dial 1 controls volume. Dials 2 and 3 control aux and USB routes. Dial 4 starts a voice conversation. The JSON configuration is generated from `streamdeck_keys` and `streamdeck_dials` in the Ansible variables.

The same controls are available on the Pi:

```sh
sudo -u smartamp smartampctl source aux toggle
sudo -u smartamp smartampctl source usb toggle
sudo -u smartamp smartampctl volume up
sudo -u smartamp smartampctl lights cycle
sudo smartamp-doctor
```

## What gets installed

PipeWire owns the HiFiBerry output and mixes all clients. The aux and USB-gadget inputs are low-latency loopbacks that can be switched independently. Squeezelite uses PipeWire's PulseAudio compatibility layer. Linux Voice Assistant is installed directly into a pinned Python virtual environment and presents an ESPHome voice satellite/media player to the remote Home Assistant. Separate local services consume its peripheral WebSocket API to drive hardware feedback. Docker is not installed.

See [architecture](docs/architecture.md), [configuration](docs/configuration.md), and [troubleshooting](docs/troubleshooting.md) for details.

## Upstream references

- [HiFiBerry DAC2 ADC Pro data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-studio-dac-adc/)
- [HiFiBerry AAmp60 data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-aamp60/)
- [HiFiBerry Pi 5 driver configuration](https://www.hifiberry.com/blog/dac-pro-dac2-pro-dac-adc-pro-on-pi5/)
- [ReSpeaker XVF3800 guide and host controls](https://wiki.seeedstudio.com/respeaker_xvf3800_introduction/)
- [Linux Voice Assistant](https://github.com/OHF-Voice/linux-voice-assistant)
- [Raspberry Pi OTG white paper](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009276-WP-1-Using%20OTG%20mode%20on%20Raspberry%20Pi%20SBCs)
