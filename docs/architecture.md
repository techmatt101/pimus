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

DAC2 ADC Pro aux --PipeWire loopback------------------------+
Computer --USB-C UAC2--+                                    |
                       +--> duckable background bus --------+--> HiFiBerry DAC --> AAmp60 --> speakers
Squeezelite / MA ------+                                    |
Linux Voice Assistant TTS/media ----------------------------+
```

## Audio ownership

PipeWire and WirePlumber run in a persistent `smartamp` system-user session. The audio manager finds devices by configurable regular expressions instead of unstable ALSA card numbers, makes HiFiBerry the default sink, makes the XVF3800 the default voice source, and creates monitor loopbacks for enabled input routes.

The voice service waits for a fresh audio-manager status file containing both
devices. It then lets the audio library resolve PipeWire's selected defaults;
`default` is not passed as a literal hardware-device name.

Squeezelite and the USB computer input feed a named background sink. Its monitor is bridged to HiFiBerry through one gain-controlled loopback; Linux Voice Assistant and aux bypass it. The controller requests ducking on wake/listen/think/TTS, announcement, and timer events. Requests are refreshed while active and expire automatically if the controller stops unexpectedly, so background audio cannot remain quiet indefinitely.

It also mirrors the HiFiBerry output monitor into the XVF3800 USB playback endpoint. Nothing is connected to the ReSpeaker speaker jack; the stream exists to give the XMOS DSP the far-end reference required for acoustic echo cancellation.

The initialisation service selects the DAC2 ADC Pro unbalanced line inputs, sets ADC gain, and limits the initial hardware output level. Both are adjustable in the Ansible variables.

## Service boundaries

- `smartamp-hifiberry`: applies hardware mixer settings after ALSA detects the HAT.
- `smartamp-usb-audio-gadget`: creates the stereo UAC2 peripheral on the Pi 5 USB-C controller.
- `smartamp-audio-manager`: maintains PipeWire defaults, switchable routes, the background bus, and its ducking gain.
- `smartamp-squeezelite`: advertises a SlimProto player to Music Assistant or LMS.
- `smartamp-voice-assistant`: pinned OHF Linux Voice Assistant checkout and Python virtual environment.
- `smartamp-controller`: maps Assist events to background ducking and XVF3800 effects, and renders/handles Stream Deck+ controls without Elgato desktop software.

The controller is one long-running Node process because ducking and both control
surfaces consume the same voice, mute, media, and audio-route state.
The audio manager remains a separate Python daemon because it continuously
reconciles the PipeWire graph and owns its gain nodes.

The Stream Deck driver uses `@elgato-stream-deck/node`, which supports the Plus model's eight key LCDs, four rotary encoders, and 800×100 touch strip. The ReSpeaker module uses USB vendor-control transfers for XVF3800 LED effects. Everything runs headlessly.

A small local LVA launcher adapter supplies pause, idle, and natural media
completion events missing from the pinned upstream peripheral protocol. This
keeps the Stream Deck play/pause state accurate without modifying the verified
upstream checkout.

The service units use a compact isolation baseline: core system configuration is
read-only, home directories are hidden, temporary directories are private, and
privilege escalation is blocked. File ownership protects application and state
paths, while USB, network, PipeWire, and configfs APIs remain available to the
hardware features that need them. The root USB-gadget service retains only its
mount and module-loading capabilities.

Home Assistant and Music Assistant/LMS are not part of this image. The Pi is a client endpoint: ESPHome protocol connects voice to the remote HA instance, while SlimProto connects Squeezelite to the remote music server.
