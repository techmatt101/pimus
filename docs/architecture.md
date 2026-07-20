# Architecture

Runtime logic is kept under `src/`; Ansible under `ansible/` only installs that
code, renders device configuration, and manages operating-system services.

```text
                                      +--------------------------+
XVF3800 microphones --USB/PipeWire--->| Linux Voice Assistant    |--ESPHome API--> Home Assistant
                                      | local wake word + media  |
                                      +------------+-------------+
                                                   | peripheral WebSocket
                                        +----------+-----------+
                                        |                      |
                                XVF3800 LED service    Stream Deck+ service

DAC2 ADC Pro aux --PipeWire loopback--+
Computer --USB-C UAC2--PipeWire--------+--> HiFiBerry DAC --> AAmp60 --> speakers
Squeezelite / Music Assistant----------+
Linux Voice Assistant TTS/media--------+
```

## Audio ownership

PipeWire and WirePlumber run in a persistent `smartamp` system-user session. The audio manager finds devices by configurable regular expressions instead of unstable ALSA card numbers, makes HiFiBerry the default sink, makes the XVF3800 the default voice source, and creates monitor loopbacks for enabled input routes.

It also mirrors the HiFiBerry output monitor into the XVF3800 USB playback endpoint. Nothing is connected to the ReSpeaker speaker jack; the stream exists to give the XMOS DSP the far-end reference required for acoustic echo cancellation.

The initialisation service selects the DAC2 ADC Pro unbalanced line inputs, sets ADC gain, and limits the initial hardware output level. Both are adjustable in the Ansible variables.

## Service boundaries

- `smartamp-hifiberry`: applies hardware mixer settings after ALSA detects the HAT.
- `smartamp-usb-audio-gadget`: creates the stereo UAC2 peripheral on the Pi 5 USB-C controller.
- `smartamp-audio-manager`: maintains PipeWire defaults and switchable aux/USB routes.
- `smartamp-squeezelite`: advertises a SlimProto player to Music Assistant or LMS.
- `smartamp-voice-assistant`: pinned OHF Linux Voice Assistant checkout and Python virtual environment.
- `smartamp-peripherals`: maps Assist states and the HA light entity to XVF3800 effects.
- `smartamp-streamdeck`: renders and handles all Stream Deck+ controls without Elgato desktop software.

The Stream Deck driver uses `@elgato-stream-deck/node`, which supports the Plus model's eight key LCDs, four rotary encoders, and 800×100 touch strip. Images are rendered by the local service without a desktop environment.

Home Assistant and Music Assistant/LMS are not part of this image. The Pi is a client endpoint: ESPHome protocol connects voice to the remote HA instance, while SlimProto connects Squeezelite to the remote music server.
