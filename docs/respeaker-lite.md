# ReSpeaker Lite

The second microphone array this recipe supports, chosen per unit with
`respeaker_board: lite`. No amp runs one yet; this page is what to expect when
one does, and what the switch gives up against the [XVF3800](xvf3800.md).

The Seeed ReSpeaker Lite is an XMOS XU316 running XMOS's far-field voice
firmware for two PDM microphones, with a TLV320AIC3204 codec driving a JST
speaker connector and a 3.5 mm jack, one WS2812 LED, a mute button with a red
indicator, and a user button. Seeed ships it with two firmware families: an
I2S build for a XIAO ESP32-S3 riding on the board, and a USB build that makes
it a UAC2 sound card. Only the USB build is any use to a Pi, and it is the
default one; the I2S build's I2C command service does not exist over USB.

## What the Pi sees

One USB audio device, ids `2886:0019`, product string `ReSpeaker Lite`, at
16 kHz. The current USB firmware is v2.0.7 (`ffva_ua`).

| Endpoint | Channels | What it carries |
| --- | --- | --- |
| Capture | 2 | Channel 0 is the processed output: echo cancellation, interference cancellation, noise suppression, and gain control. Channel 1 is one raw microphone. |
| Playback | 2 | Whatever the Pi plays is the DSP's far-end echo reference, and is also played out of the speaker connector or the jack. |

The audio manager therefore remaps capture channel 0 into the mono
`smartamp_voice_capture` source (the XVF3800 uses channel 1), and the AEC
reference loopback lands on the same playback sink it would on an XVF3800.
Nothing in the audio manager or the voice assistant branches on which array is
fitted; the difference is entirely in the `boards.yml` row that inventory reads
its defaults from.

There is no host control over USB. The DSP's parameters cannot be read or
tuned from the Pi, so `xvf_host` is not installed, and the WS2812 is released
by the USB firmware at boot (v2.0.6 and later), so nothing on the Pi can light
it. A unit with a Lite must set `respeaker_led_enabled: false`, and preflight
refuses the pair by name; voice-state feedback is the Stream Deck's alone.
The listening ripples that follow a talker round the XVF3800's ring have no
equivalent either, because the Lite reports no direction of arrival.

## Switching a unit

In the unit's `host_vars`:

```yaml
respeaker_board: lite
respeaker_led_enabled: false
```

Then `make provision LIMIT=<unit>`. Provisioning removes the XVF3800 host tool
and its udev rule, points the device match and the capture channel at the Lite,
and `smartamp-doctor` looks for `2886:0019` on the bus. Placement matters more
than on the four-microphone array: the Lite is directional, so face the
microphones at the room and away from the speakers.

The processed channel is at the mercy of the same wake-word threshold as the
XVF3800's ASR stream, so the [wake word over music](xvf3800.md#wake-word-over-music)
levers apply unchanged; they are voice assistant preferences, not array
settings.

## Echo cancellation caveat

Seeed states the AEC is active in the USB firmware and needs no enabling, and
their own recordings show it working. Several users on Seeed's forum, testing
with a speaker on the board's own connector, report the processed channel
cancelling nothing at all on v2.0.6 and v2.0.7. Nobody has measured it on an
amp yet. When a Lite is first fitted, run the same noise test the XVF3800 gets,
minus the convergence flag the Lite cannot report: play noise, record both
capture channels, and compare how much of the noise the processed channel
removes against the raw one. If it removes little, the reference path is the
first suspect (the `aec_reference` section of the status file, and headphones
in the Lite's jack should carry the music), and the firmware is the second.

## Firmware

Seeed publishes the USB firmware as a DFU image in the
[reSpeaker_Lite](https://github.com/respeaker/reSpeaker_Lite) repository and
flashes it with `dfu-util`; the board must be on the USB-C port beside the
3.5 mm jack for that. This recipe does not flash arrays. If a unit's Lite is on
an older build, note that v2.0.6 is where the LED was released and v2.0.7 adds
support for a newer flash part; the wiki's FAQ says a board that does not
appear as a sound device at all is on the I2S build or below v2.0.5.

## References

- [Getting Started with reSpeaker Lite](https://wiki.seeedstudio.com/reSpeaker_usb_v3/)
  — the product, pinout, specification, and the DFU procedure.
- [reSpeaker_Lite on GitHub](https://github.com/respeaker/reSpeaker_Lite)
  — firmware images, the changelog, and the I2C command service the I2S build
  exposes (not available over USB).
- [Respeaker Lite AEC support](https://forum.seeedstudio.com/t/respeaker-lite-aec-support/283114)
  — the forum thread with Seeed's channel layout answer and users' AEC
  reports.
- [ReSpeaker XVF3800](xvf3800.md) — the other array, and the wake-word and
  measurement notes that apply to both.
