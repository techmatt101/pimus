# Configuration

All supported settings live in `ansible/inventory/group_vars/all.yml`. Re-run `make provision` after changing them.

## Audio

`hifiberry_aux_gain_db` is the analogue ADC input gain. Start at `0`; line-level sources can clip if this is raised too far. `hifiberry_output_volume_percent` is the safe boot-time hardware level. Normal volume control remains available through Home Assistant and the Stream Deck.

Device match expressions search every PipeWire/Pulse node property. Use `pactl list sinks` and `pactl list sources` on the Pi if your firmware exposes different names.

Set `smartamp_aux_enabled` to choose whether aux monitoring starts on boot. USB monitoring is initially enabled when `usb_audio_gadget_enabled` is true. The Stream Deck or `smartampctl` persists subsequent route state.

Voice ducking is enabled by `smartamp_voice_ducking_enabled`. Squeezelite and USB computer audio share the `smartamp_background_sink_name` bus and fade to `smartamp_voice_duck_volume_percent` during an Assist interaction. `smartamp_voice_duck_fade_ms` controls the transition. The controller refreshes a runtime lease every `smartamp_voice_duck_refresh_seconds`; the audio manager restores full background volume after `smartamp_voice_duck_timeout_seconds` if that lease becomes stale.

Aux is deliberately not on the duckable bus. It continues at its selected level during voice interactions. Set the generated source target to `background` as a code-level extension if aux should follow the same policy.

## SD-card endurance

The image is tuned for minimal flash writes. `smartamp_journal_in_ram` keeps
systemd logs for the current boot in RAM (see the troubleshooting note about
logs not surviving reboots), and `smartamp_swapfile_enabled: false` removes the
stock dphys-swapfile so memory pressure cannot grind the card — if RAM is ever
exhausted, the kernel OOM-kills the largest process and systemd restarts it.
Application state that must survive reboots (route toggles, LED mode) is
written only when its content changes; frequently refreshed files (ducking
lease, audio status) live under `/run`, which is RAM-backed.

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

The same Node controller handles the HA light command, ReSpeaker USB transfer,
and Stream Deck **Lights** action. `smartampctl lights ...` remains available to
shell automation; it updates the shared LED state watched by the controller.

The state files and PipeWire session belong to the `smartamp` service account,
so run shell automation as that user, for example
`sudo -u smartamp smartampctl lights cycle`. Invoked as another user,
`smartampctl` explains this instead of failing with a traceback.

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

Put private host or group overrides in files ending in `.vault.yml` under
`ansible/inventory/host_vars` or `ansible/inventory/group_vars`, and encrypt
them with Ansible Vault before keeping them locally. Those filenames are
ignored by Git so an unencrypted working copy is not committed accidentally.
