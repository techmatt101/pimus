# Pimus Smart Amp

An idempotent Raspberry Pi build recipe, for a Pi 5, a Pi 4 Model B, or a Pi Zero 2 W, for:

- HiFiBerry DAC2 ADC Pro with the AAmp60 add-on amplifier, or a HiFiBerry Amp100
- ReSpeaker XMOS XVF3800 USB four-microphone array
- Elgato Stream Deck+
- analogue aux input (on a board with an ADC), computer audio over USB-C, Home Assistant media, and Music Assistant
  playback over Sendspin
- Home Assistant Assist, local wake word, voice responses, timers, and announcements
- configurable ReSpeaker LEDs and Stream Deck+ keys, dials, and touch strip

The recipe targets a fresh 64-bit Raspberry Pi OS Lite Bookworm or Trixie install. It provisions the Pi directly over
SSH; running it again produces the same configuration and safely applies later changes.

## Read this before powering the stack

The AAmp60 is compatible with the DAC+ ADC Pro family, but its published power guarantee only covers Raspberry Pi models
through Pi 4. A Pi 5 can expose up to 1.6 A to USB peripherals only with a 5 A supply, and a Pi 4B is fixed at roughly
1.2 A across all four USB-A ports whatever it is powered from; the amplifier, XVF3800 and Stream Deck+ combination
therefore needs power validation either way. On a Pi Zero 2 W the question does not arise: it has one micro-USB data
port, so **a self-powered hub is required**, and the deck and the ReSpeaker draw from that rather than from the Pi. Use
`smartamp-doctor` to check the Pi throttle/under-voltage flags, and plan on a powered USB hub if flags appear or USB
devices reset. Either amplifier board feeds the Pi from its own DC supply through the GPIO header, so size that supply
for the whole stack rather than the amplifier alone.

The optional USB audio input changes the USB-C port into a peripheral port. The Pi must then be powered through the
HiFiBerry GPIO stack. Connect the USB-C port to the source computer; the four USB-A ports remain hosts for the
ReSpeaker and Stream Deck+. **On a Pi 4B that host cable must have its power line cut**: that board wires USB-C VBUS
straight onto the same 5 V rail as the GPIO header, so the computer and the AAmp60 would otherwise feed the rail against
each other. The Pi 5's PMIC arbitrates instead. A Pi Zero 2 W has no second port to spare, so it cannot do this at all —
provisioning refuses `usb_audio_gadget_enabled` there.

### Which HiFiBerry board

`hifiberry_board` in inventory names the board, because the recipe tells the firmware to ignore the HAT's own EEPROM so
the chosen overlay always wins — nothing can detect it afterwards.

| `hifiberry_board` | Board | Aux line-in | Amplifier mute |
| --- | --- | --- | --- |
| `dac2adcpro` | DAC2 ADC Pro, with the AAmp60 add-on amplifier | yes, its ADC | no — the AAmp60 has no control line |
| `amp100` | Amp100, an amplifier with its own DAC | **no ADC at all** | yes, `hifiberry_auto_mute` |

On an Amp100 there is no analogue line-in: provisioning refuses `smartamp_aux_enabled`, the generated audio
configuration carries no aux route, and the ADC mixer controls are not written. The deck's AUX key then draws greyed
and does nothing when pressed, so the compiled layout needs no per-unit edit — the same applies to the USB key on a
unit built without the audio gadget.

`hifiberry_auto_mute` mutes the Amp100's amplifier whenever the audio device is closed and unmutes it as the stream
opens, so nothing is clipped off the front of playback and the amplifier stops hissing into an empty room during the
quiet the idle teardown already creates. It is off by default because the transition can click on some speakers. The
overlay's other parameters — `leds_off`, `mute_ext_ctl`, `24db_digital_gain`, `slave` — are deliberately not
exposed; `mute_ext_ctl` in particular would add a second, competing way to mute, beside the one the volume dial and
Home Assistant already drive.

### What differs between the Raspberry Pis

The board is detected from `/proc/device-tree/model`. Everything it can do is provisioned; anything it cannot is
refused by name before provisioning changes anything, so inventory always describes what the device actually does.

| | Pi 5 | Pi 4 Model B | Pi Zero 2 W |
| --- | --- | --- | --- |
| Sleep cuts USB power (`smartamp_sleep_usb_power_off`) | yes | yes, with VL805 firmware `000137ad`+ | **no** |
| USB sound card (`usb_audio_gadget_enabled`) | yes | yes, power-cut cable | **no** |
| Power button as the sleep/wake toggle | yes | none | none |
| `smartamp_power_off_on_halt`, `smartamp_wake_on_gpio` | yes | yes | **no bootloader EEPROM** |
| `smartamp_wait_for_power_button` | yes | no | **no** |
| `usb_audio_psu_max_current_ma` | yes | fixed ~1.2 A in hardware | n/a |

A **Pi 4B** switches VBUS through its VL805 hub, across all four sockets at once, but only on firmware `000137ad` or
newer (`sudo rpi-eeprom-update`). Older firmware accepts the write and leaves the sockets lit; `smartamp-doctor`
reports the version and checks the port controls are actually there. It has no dedicated power button, so provisioning
leaves stock `logind` handling alone and refuses `smartamp_power_off_on_halt` unless `smartamp_wake_on_gpio` is also on
— shorting GPIO3 or `GLOBAL_EN` to ground is then the only way to start a halted board short of a plug cycle. The same
gap applies to sleep: with `smartamp_sleep_usb_power_off` on, the deck is dark and there is no button, so **presence
returning is the only thing that wakes a sleeping Pi 4B**. Turn the flag off to keep a deck touch as a wake source.

A **Pi Zero 2 W** has one micro-USB data port beside its power-only one, so the deck, the ReSpeaker, and any Ethernet
adapter all arrive through a self-powered hub. That single port is why there is no USB sound card here: being one would
mean unplugging the hub. It also means nothing to switch off in sleep — the hub feeds the devices, not the Pi — so the
panel sleeps and a touch wakes it, as with the flag off anywhere else. Being a BCM2710 it boots from the card and has
no bootloader EEPROM at all, so the three power flags above must be false; `poweroff` leaves the board's rails up and
the stack at the AAmp60's quiescent draw rather than at ~0 W. Its 512 MB is the tightest RAM this stack runs in: leave
`smartamp_zram_enabled` on and watch the headroom `smartamp-doctor` reports.

The supported boards and their capabilities live in
[`ansible/roles/smartamp/vars/boards.yml`](ansible/roles/smartamp/vars/boards.yml).

## Quick start

On the fresh Pi, use Raspberry Pi Imager to enable SSH and create your normal admin user. From this control computer:

The control computer needs Python with Ansible, plus Node.js and
[pnpm](https://pnpm.io/installation) to compile the controller. The Pi itself
needs neither Ansible, pnpm, nor a TypeScript toolchain.

```sh
python3 -m pip install --user ansible
corepack enable pnpm   # or: npm install -g pnpm
make install
```

Edit [`ansible/inventory/hosts.yml`](ansible/inventory/hosts.yml) so the hostname/IP and `ansible_user` match the Pi.
Review the feature settings in [`ansible/inventory/group_vars/all.yml`](ansible/inventory/group_vars/all.yml), then run:

```sh
ssh matt@office-amp.local  # accept the new host key, then exit
make provision
```

Boot configuration changes trigger one reboot. When provisioning finishes:

```sh
make doctor
```

In Home Assistant, open **Settings → Devices & services**. The device named **Office Amp Voice** should be discovered by
the ESPHome integration. Add it and select the desired Assist pipeline. The ReSpeaker LED ring is purely reactive — it
reflects voice, media, timer, mute, and error states configured in the Ansible variables.

For Music Assistant, the Sendspin player named **Office Amp** appears automatically — the Sendspin provider is built
into Music Assistant and mDNS discovery normally works on the local network. Otherwise set `sendspin_server_url` to the
Music Assistant Sendspin WebSocket URL and provision again. The Sendspin client requires Python 3.12, so use a
Trixie-based (or newer) Raspberry Pi OS image, or set `sendspin_enabled: false` on Bookworm.

This project installs no Home Assistant or Music Assistant server components. `office-amp` is only a network audio/voice
endpoint; the server and media library remain on your other machine.

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

- `apps/controller`: one TypeScript/Node daemon for Stream Deck+, ReSpeaker LEDs, and voice-state events.
  `make provision` compiles it here and deploys the resulting JavaScript.
- `apps/audio-manager`: the Python PipeWire reconciliation daemon and its colocated tests.
- `apps/playground`: a development-only debug environment that runs the controller on this computer against fake
  hardware. Not deployed.
- `ansible`: inventory, playbooks, deployment tasks, generated configuration, and systemd templates.

Each app owns its `src/` directory and, where applicable, a sibling `test/`
directory. See [`apps/README.md`](apps/README.md) for the module boundaries. The
two Node apps form a pnpm workspace, so one `pnpm install` at the root sets up
both; the workspace and its lockfile are development tooling and never reach the
Pi, which installs the controller's exact pins with plain npm.

## Everyday control

The default Stream Deck+ layout has three pages — four with remote tiles
enabled — with the two bottom corners navigating between them:

| Page   | Keys                                                                                                                                                                                                             |
|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Main   | Voice (start or cancel Assist), mic mute, play/pause, shuffle, and the AUX and USB route toggles                                                                                                                 |
| Room   | Scenes, ceiling fan, blinds, desk PC, a Home Assistant timer, and the lights                                                                                                                                     |
| Info   | Clock, room temperature, weather, panel brightness, stop, and a playlist shortcut                                                                                                                                |
| Remote | Only with remote tiles enabled: six keys another computer on the LAN fills over an authenticated WebSocket, receiving the presses back — see [remote tiles](docs/controls.md#remote-tiles-from-another-computer) |

Dial 1 controls volume, dial 2 is media transport (previous/next, press to
play/pause), and dial 3 is spare. Dial 4 has no fixed job: pressing the lights,
fan, or blinds key hands it that entity, so the same knob dims, changes speed,
and opens, and the key holding it is marked. See
[the dynamic dial](docs/controls.md#the-dynamic-dial).

The touch strip above the dials shows what is playing — title, artist, and a
position bar — and swaps to the dial you are turning while you turn it. Home
Assistant automations can also put a message on it (someone at the door, the
washing machine has finished) by firing a `smartamp_notify` event; tap the strip
to acknowledge one. See [controls](docs/controls.md#the-touch-strip).

Everything on the Room and Info pages, plus shuffle, the playlist, and the
dynamic dial, talks to Home Assistant, so those keys show live state as well as
change it — set `home_assistant_url` in inventory and put a long-lived access
token in the Pi's [secrets file](docs/configuration.md#secrets). Without them
those keys stay in place and draw an unknown state.

The layout is defined in `apps/controller/src/streamdeck/layout.mts`, with the
entity ids it drives gathered at the top of that file. The controller opens the
Stream Deck+ model specifically and queues rapid encoder steps in order.

To change what a key or dial does, see [controls](docs/controls.md) for every
available action. To try a change without a Pi or a Stream Deck attached, run
`make playground` — it runs the real controller on this computer and draws the
deck in a browser — or `make dev` to have it rebuild and reload as you edit. See
[playground](docs/playground.md).

Run `sudo smartamp-doctor` on the Pi for a health report.

## What gets installed

PipeWire owns the HiFiBerry output and mixes all clients. Aux remains an independently switchable direct loopback.
USB-gadget audio and Sendspin share a background bus that fades to 15% while Assist listens, thinks, speaks, announces,
or rings a timer, then returns to full level. Linux Voice Assistant bypasses that bus and presents an ESPHome voice
satellite/media player to the remote Home Assistant. One local Node controller consumes its peripheral WebSocket API and
coordinates ducking, the Stream Deck+, and ReSpeaker LEDs. Docker is not installed.

See [architecture](docs/architecture.md), [configuration](docs/configuration.md), [controls](docs/controls.md), [playground](docs/playground.md),
and [troubleshooting](docs/troubleshooting.md) for details.

## Upstream references

- [HiFiBerry DAC2 ADC Pro data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-studio-dac-adc/)
- [HiFiBerry AAmp60 data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-aamp60/)
- [HiFiBerry Pi 5 driver configuration](https://www.hifiberry.com/blog/dac-pro-dac2-pro-dac-adc-pro-on-pi5/)
- [ReSpeaker XVF3800 guide and host controls](https://wiki.seeedstudio.com/respeaker_xvf3800_introduction/)
- [Linux Voice Assistant](https://github.com/OHF-Voice/linux-voice-assistant)
- [Raspberry Pi OTG white paper](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009276-WP-1-Using%20OTG%20mode%20on%20Raspberry%20Pi%20SBCs)
