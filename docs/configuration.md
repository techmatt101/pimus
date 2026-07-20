# Configuration

All supported settings live in `ansible/inventory/group_vars/all.yml`. Re-run `make provision` after changing them.

## Audio

`hifiberry_aux_gain_db` is the analogue ADC input gain. Start at `0`; line-level sources can clip if this is raised too far. `hifiberry_output_volume_percent` is the safe boot-time hardware level. Normal volume control remains available through Home Assistant and the Stream Deck.

Device match expressions search every PipeWire/Pulse node property. Use `pactl list sinks` and `pactl list sources` on the Pi if your firmware exposes different names.

Set `smartamp_aux_enabled` to choose whether aux monitoring starts on boot. USB monitoring is initially enabled when `usb_audio_gadget_enabled` is true. Stream Deck route toggles last until the next reboot; every boot starts from these inventory defaults.

Voice ducking is enabled by `smartamp_voice_ducking_enabled`. Squeezelite and USB computer audio share the `smartamp_background_sink_name` bus and fade to `smartamp_voice_duck_volume_percent` during an Assist interaction. `smartamp_voice_duck_fade_ms` controls the transition. The controller requests ducking over the audio manager's control socket, which releases the request automatically if the controller disconnects.

Aux is deliberately not on the duckable bus. It continues at its selected level during voice interactions. Set the generated source target to `background` as a code-level extension if aux should follow the same policy.

## SD-card endurance

The image is tuned for minimal flash writes. `smartamp_journal_in_ram` keeps
systemd logs for the current boot in RAM (see the troubleshooting note about
logs not surviving reboots), and `smartamp_swapfile_enabled: false` removes the
stock dphys-swapfile so memory pressure cannot grind the card — if RAM is ever
exhausted, the kernel OOM-kills the largest process and systemd restarts it.
Route toggles and duck requests live in the audio manager's memory and travel
over a Unix socket in the runtime directory; the audio status file lives under
`/run`, which is RAM-backed. Routine operation therefore never writes to the
card, and route toggles reset to inventory defaults at boot.

## Voice

`voice_assistant_version` names the upstream release, while
`voice_assistant_commit` pins its immutable source revision. The upstream setup
script installs its declared Python dependencies into
`/opt/smartamp/linux-voice-assistant/.venv`; no container runtime is used.
`voice_assistant_wake_model` defaults to `okay_nabu`. Custom OpenWakeWord model
files can be placed in `/var/lib/smartamp/lva/wakewords` and selected by name.
The remote Home Assistant Assist pipeline supplies speech-to-text,
conversation handling, and text-to-speech.

The XVF3800 already performs AEC, beamforming, dereverberation, noise suppression and gain control. Leave LVA software noise suppression and auto-gain disabled initially to avoid processing the signal twice.

## ReSpeaker effects

Each `respeaker_led_states` entry accepts:

```yaml
listening:
  effect: doa        # off, breath, rainbow, single, doa, ring
  color: "#001018"
  accent: "#00e5ff" # DOA highlight
```

The `ring` effect writes all 12 XVF3800 ring-colour slots using `color`.
The `doa` effect uses `color` for the base plus `accent` for its highlight.

The ring is purely reactive: it renders the configured appearance for the
current voice, media, timer, mute, or error state and nothing else. There is
no separately controllable lamp mode, no persisted LED state, and no Home
Assistant light entity.

Feature flags are reversible: disabling voice, Squeezelite, USB gadget audio,
or every controller consumer stops the relevant service and removes its
installed runtime artifacts. Persistent preferences and downloaded wake-word
models under `/var/lib/smartamp` are retained for a later re-enable.

## Stream Deck+

`streamdeck_enabled` turns the control surface on or off for this unit. Set it
to `false` for an LED-only deployment with no deck attached.

The key and dial layout, and the panel brightness, are defined in the
controller itself at `apps/controller/src/streamdeck/layout.mts`, not in the
inventory — edit that file and run `make deploy-controller`. Every available
action, with examples and the key feedback each one produces, is listed in
[controls](controls.md). A mistyped `route`/`volume` command is a compile
error, and `make test` rejects any action the catalog does not understand.

Webhook actions POST to `home_assistant_webhook_base/<id>`. Configure a Home Assistant webhook trigger and set the base to `http://homeassistant.local:8123/api/webhook`. Treat webhook IDs as secrets if the endpoint is reachable outside a trusted LAN.

Put private host or group overrides in files ending in `.vault.yml` under
`ansible/inventory/host_vars` or `ansible/inventory/group_vars`, and encrypt
them with Ansible Vault before keeping them locally. Those filenames are
ignored by Git so an unencrypted working copy is not committed accidentally.
