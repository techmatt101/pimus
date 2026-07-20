# Applications

Each deployable program owns its source and tests here. Ansible is responsible
only for installing these apps, rendering configuration, and managing services.

## `controller`

The long-running TypeScript app in `controller/src/` turns LVA events into audio
policy and shares voice/audio state between both USB control surfaces:

- `index.mts` composes and starts the app.
- `config.mts` loads and validates `/etc/smartamp/controller.json`.
- `lva-client.mts` owns the reconnecting Linux Voice Assistant WebSocket.
- `ducking.mts` turns voice events into a refreshed, crash-safe ducking lease.
- `respeaker.mts` maps voice state to XVF3800 USB LED commands.
- `deck-controller.mts` owns Stream Deck discovery, reconnects, and input events.
- `display.mts`, `bitmap.mts`, and `state.mts` render the Stream Deck display.
- `actions.mts` dispatches voice, audio, and webhook actions.
- `system-control.mts` runs `wpctl` volume commands, applies route toggles to
  the shared audio state file, and polls PipeWire output state.
- `types.mts` declares the configuration, voice-event, and device interfaces
  shared across modules; its config types mirror `controller.json.j2`.

`tsc` compiles these `.mts` sources to `.mjs` in `controller/dist/`, which is
build output rather than tracked source. The compiler runs only on this
computer: Ansible deploys the compiled `dist/src/*.mjs` modules, so the Pi keeps
running plain ESM under the Debian `nodejs` package with no build tooling
installed. Run `make build` (or `npm run build`) before provisioning.

`controller/test/` exercises the shared state, action dispatch, rendering
helpers, and ReSpeaker USB protocol without requiring either physical device.
The package lock pins the dependency tree deployed with `npm ci`; TypeScript and
the type packages are development-only and are omitted from the Pi.

## `audio-manager`

The long-running Python daemon in `audio-manager/src/` makes HiFiBerry the
default output, selects the XVF3800 microphone, and maintains aux, USB audio,
the Squeezelite/USB background bus, ducking gain, and acoustic-echo-reference
PipeWire routes. Its unit tests are colocated in `audio-manager/test/`.

## `smartampctl`

The Python program in `smartampctl/src/` is a short-lived command, not a daemon.
It changes PipeWire volume or persistent aux/USB route state and exits. Its unit tests are colocated in
`smartampctl/test/`.
