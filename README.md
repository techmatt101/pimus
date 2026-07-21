# Pimus Smart Amp

An idempotent Raspberry Pi 5 build recipe for:

- HiFiBerry DAC2 ADC Pro with the AAmp60 add-on amplifier
- ReSpeaker XMOS XVF3800 USB four-microphone array
- Elgato Stream Deck+
- analogue aux input, computer audio over USB-C, Home Assistant media, and Music Assistant playback over Sendspin
- Home Assistant Assist, local wake word, voice responses, timers, and announcements
- configurable ReSpeaker LEDs and Stream Deck+ keys, dials, and touch strip

The recipe targets a fresh 64-bit Raspberry Pi OS Lite Bookworm or Trixie install. It provisions the Pi directly over SSH; running it again produces the same configuration and safely applies later changes.

## Read this before powering the stack

The AAmp60 is compatible with the DAC+ ADC Pro family, but its published power guarantee only covers Raspberry Pi models through Pi 4. A Pi 5 can expose up to 1.6 A to USB peripherals only with a 5 A supply; the AAmp60, XVF3800 and Stream Deck+ combination therefore needs power validation. Use `smartamp-doctor` to check the Pi throttle/under-voltage flags, and plan on a powered USB hub if flags appear or USB devices reset.

The optional USB audio input changes the Pi 5 USB-C port into a peripheral port. The Pi must then be powered through the HiFiBerry/AAmp60 GPIO stack. Connect the USB-C port to the source computer; the four USB-A ports remain hosts for the ReSpeaker and Stream Deck+.

## Quick start

On the fresh Pi, use Raspberry Pi Imager to enable SSH and create your normal admin user. From this control computer:

The control computer needs Python with Ansible, plus Node.js 18.18 or newer and
npm to compile the controller. The Pi itself needs neither Ansible nor a
TypeScript toolchain.

```sh
python3 -m pip install --user ansible
make install
```

Edit [`ansible/inventory/hosts.yml`](ansible/inventory/hosts.yml) so the hostname/IP and `ansible_user` match the Pi. Review the feature settings in [`ansible/inventory/group_vars/all.yml`](ansible/inventory/group_vars/all.yml), then run:

```sh
ssh matt@office-amp.local  # accept the new host key, then exit
make provision
```

Boot configuration changes trigger one reboot. When provisioning finishes:

```sh
make doctor
```

In Home Assistant, open **Settings → Devices & services**. The device named **Office Amp Voice** should be discovered by the ESPHome integration. Add it and select the desired Assist pipeline. The ReSpeaker LED ring is purely reactive — it reflects voice, media, timer, mute, and error states configured in the Ansible variables.

For Music Assistant, the Sendspin player named **Office Amp** appears automatically — the Sendspin provider is built into Music Assistant and mDNS discovery normally works on the local network. Otherwise set `sendspin_server_url` to the Music Assistant Sendspin WebSocket URL and provision again. The Sendspin client requires Python 3.12, so use a Trixie-based (or newer) Raspberry Pi OS image, or set `sendspin_enabled: false` on Bookworm.

This project installs no Home Assistant or Music Assistant server components. `office-amp` is only a network audio/voice endpoint; the server and media library remain on your other machine.

### Updating the controller

The Node controller changes more often than the rest of the system. After a Pi
has been fully provisioned once, deploy controller changes on their own:

```sh
make deploy-controller
```

This recompiles the TypeScript, validates the inventory, copies the compiled
modules, dependencies, and generated `controller.json` to the Pi, and restarts
`smartamp-controller` — without touching audio, voice, or boot configuration.
Use the full `make provision` after changing anything outside
`apps/controller` or its inventory settings.

## Project layout

- `apps/controller`: one TypeScript/Node daemon for Stream Deck+, ReSpeaker LEDs, and voice-state events. `make provision` compiles it here and deploys the resulting JavaScript.
- `apps/audio-manager`: the Python PipeWire reconciliation daemon and its colocated tests.
- `ansible`: inventory, playbooks, deployment tasks, generated configuration, and systemd templates.

Each app owns its `src/` directory and, where applicable, a sibling `test/`
directory. See [`apps/README.md`](apps/README.md) for the module boundaries.

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

Dial 1 controls volume. Dials 2 and 3 control aux and USB routes. Dial 4 starts a voice conversation. The layout is defined in `apps/controller/src/streamdeck/layout.mts`.
The controller opens the Stream Deck+ model specifically, queues rapid encoder
steps in order, and shows the current AUX/USB route state on those two dials.

To change what a key or dial does, see [controls](docs/controls.md) for every
available action.

Run `sudo smartamp-doctor` on the Pi for a health report.

## What gets installed

PipeWire owns the HiFiBerry output and mixes all clients. Aux remains an independently switchable direct loopback. USB-gadget audio and Sendspin share a background bus that fades to 15% while Assist listens, thinks, speaks, announces, or rings a timer, then returns to full level. Linux Voice Assistant bypasses that bus and presents an ESPHome voice satellite/media player to the remote Home Assistant. One local Node controller consumes its peripheral WebSocket API and coordinates ducking, the Stream Deck+, and ReSpeaker LEDs. Docker is not installed.

See [architecture](docs/architecture.md), [configuration](docs/configuration.md), [controls](docs/controls.md), and [troubleshooting](docs/troubleshooting.md) for details.

## Upstream references

- [HiFiBerry DAC2 ADC Pro data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-studio-dac-adc/)
- [HiFiBerry AAmp60 data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-aamp60/)
- [HiFiBerry Pi 5 driver configuration](https://www.hifiberry.com/blog/dac-pro-dac2-pro-dac-adc-pro-on-pi5/)
- [ReSpeaker XVF3800 guide and host controls](https://wiki.seeedstudio.com/respeaker_xvf3800_introduction/)
- [Linux Voice Assistant](https://github.com/OHF-Voice/linux-voice-assistant)
- [Raspberry Pi OTG white paper](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009276-WP-1-Using%20OTG%20mode%20on%20Raspberry%20Pi%20SBCs)
