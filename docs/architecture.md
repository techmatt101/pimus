# Architecture

Runtime logic is grouped by deployable component under `apps/`; each app owns
its `src/` and tests. Ansible only installs that code, renders configuration,
and manages operating-system services.

```text
                                      +--------------------------+
XVF3800 microphones --USB/PipeWire--->| Linux Voice Assistant    |--ESPHome API--> Home Assistant
                                      | local wake word + media  |
                                      +------------+-------------+
                                                   | peripheral WebSocket
                                      +------------+-------------+
                                      | Node hardware controller |
                                      +------+---------------+---+
                                             | USB           | HID
                                      XVF3800 LEDs       Stream Deck+

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
- `smartamp-controller`: maps Assist/HA light state to XVF3800 effects and renders/handles Stream Deck+ controls without Elgato desktop software.

The controller is one long-running Node process because both control surfaces
consume the same voice, mute, media, audio-route, and LED-mode state. The audio
manager remains a separate Python daemon because it continuously reconciles the
PipeWire graph. `smartampctl` remains a short-lived CLI so SSH and automation can
change state without needing a second control protocol.

The Stream Deck driver uses `@elgato-stream-deck/node`, which supports the Plus model's eight key LCDs, four rotary encoders, and 800×100 touch strip. The ReSpeaker module uses USB vendor-control transfers for XVF3800 LED effects. Everything runs headlessly.

Home Assistant and Music Assistant/LMS are not part of this image. The Pi is a client endpoint: ESPHome protocol connects voice to the remote HA instance, while SlimProto connects Squeezelite to the remote music server.
