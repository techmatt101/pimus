# Configuration

All supported settings live in `inventory/group_vars/all.yml`. Re-run `make provision` after changing them.

## Audio

`hifiberry_aux_gain_db` is the analogue ADC input gain. Start at `0`; line-level sources can clip if this is raised too far. `hifiberry_output_volume_percent` is the safe boot-time hardware level. Normal volume control remains available through Home Assistant and the Stream Deck.

Device match expressions search every PipeWire/Pulse node property. Use `pactl list sinks` and `pactl list sources` on the Pi if your firmware exposes different names.

Set `smartamp_aux_enabled` to choose whether aux monitoring starts on boot. USB monitoring is initially enabled when `usb_audio_gadget_enabled` is true. The Stream Deck or `smartampctl` persists subsequent route state.

## Voice

`voice_assistant_version` pins the upstream Git release installed into `/opt/smartamp/linux-voice-assistant/.venv`; no container runtime is used. `voice_assistant_wake_model` defaults to `okay_nabu`. Custom OpenWakeWord model files can be placed in `/var/lib/smartamp/lva/wakewords` and selected by name. The remote Home Assistant Assist pipeline supplies speech-to-text, conversation handling, and text-to-speech.

The XVF3800 already performs AEC, beamforming, dereverberation, noise suppression and gain control. Leave LVA software noise suppression and auto-gain disabled initially to avoid processing the signal twice.

## ReSpeaker effects

Each `respeaker_led_states` entry accepts:

```yaml
listening:
  effect: doa        # off, breath, rainbow, single, doa, ring
  color: "#001018"
  accent: "#00e5ff" # DOA highlight
```

Home Assistant receives an RGB light entity through LVA's peripheral API. Its **Voice Assistant** effect returns control to state feedback. Critical mute, disconnect, error and ringing-timer indications override a decorative local mode.

## Stream Deck+

Supported action objects are:

```yaml
{ type: lva, command: start_listening }
{ type: audio, source: aux, command: toggle }
{ type: audio, command: mute }
{ type: led, command: cycle }
{ type: webhook, id: movie_mode }
{ type: noop }
```

LVA commands include `start_listening`, `volume_up`, `volume_down`, `stop_timer_ringing`, `pause_media_player`, and `resume_media_player`. The local `mute_toggle`, `media_toggle`, and `stop` helpers are also supported.

Webhook actions POST to `home_assistant_webhook_base/<id>`. Configure a Home Assistant webhook trigger and set the base to `http://homeassistant.local:8123/api/webhook`. Treat webhook IDs as secrets if the endpoint is reachable outside a trusted LAN.
