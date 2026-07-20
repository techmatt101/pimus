# Applications

Each deployable program owns its source and tests here. Ansible is responsible
only for installing these apps, rendering configuration, and managing services.

## `controller`

The long-running Node app in `controller/src/` turns LVA events into audio
policy and shares voice/audio state between both USB control surfaces:

- `index.mjs` composes and starts the app.
- `config.mjs` loads and validates `/etc/smartamp/controller.json`.
- `lva-client.mjs` owns the reconnecting Linux Voice Assistant WebSocket.
- `ducking.mjs` turns voice events into a refreshed, crash-safe ducking lease.
- `respeaker.mjs` maps voice/HA/local state to XVF3800 USB LED commands.
- `deck-controller.mjs` owns Stream Deck discovery, reconnects, and input events.
- `display.mjs`, `bitmap.mjs`, and `state.mjs` render the Stream Deck display.
- `actions.mjs` dispatches voice, audio, LED, and webhook actions.
- `system-control.mjs` invokes `smartampctl` for audio and reads PipeWire state.

`controller/test/` exercises the shared state, action dispatch, rendering
helpers, and ReSpeaker USB protocol without requiring either physical device.
The package lock pins the dependency tree deployed with `npm ci`.

## `audio-manager`

The long-running Python daemon in `audio-manager/src/` makes HiFiBerry the
default output, selects the XVF3800 microphone, and maintains aux, USB audio,
the Squeezelite/USB background bus, ducking gain, and acoustic-echo-reference
PipeWire routes. Its unit tests are colocated in `audio-manager/test/`.

## `smartampctl`

The Python program in `smartampctl/src/` is a short-lived command, not a daemon.
It changes PipeWire volume or persistent aux/USB/LED state and exits. The Node
controller watches the LED state file, so shell commands and Stream Deck actions
converge on the same ReSpeaker behavior.
