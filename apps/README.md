# Applications

Each deployable program owns its source and tests here. Ansible is responsible
only for installing these apps, rendering configuration, and managing services.
`playground` is the exception: a development-only tool that is never deployed.

## `controller`

The long-running TypeScript app in `controller/src/` turns LVA events into audio
policy and shares voice/audio state between both USB control surfaces. Modules
are grouped by the boundary they own:

- `index.mts` composes and starts the app.
- `config.mts` loads and validates `/etc/smartamp/controller.json`, rejecting an
  action that no longer exists in the catalog.
- `state.mts` holds the display/voice state shared across every module.
- `types.mts` declares the configuration, voice-event, and device interfaces
  shared across modules; its config types mirror `controller.json.j2`.
- `actions/` — `catalog.mts` declares every action a key or dial can be bound
  to, and `handler.mts` runs them. See [docs/controls.md](../docs/controls.md).
- `audio/` — `manager-client.mts` mirrors route, level, and mute state over the
  audio manager socket, and `ducking.mts` turns voice events into duck requests
  on that same socket.
- `streamdeck/` — `layout.mts` is the editable key/dial layout, `deck.mts` owns
  discovery, reconnects, and input events, and `renderer.mts` and `bitmap.mts`
  draw the keys and LCD strip.
- `voice/` — `lva-client.mts` owns the reconnecting Linux Voice Assistant
  WebSocket, `respeaker.mts` maps voice state to an LED appearance, and
  `xvf3800-device.mts` holds the XMOS vendor-control protocol and its USB
  transport.

`tsc` compiles these `.mts` sources to `.mjs` in `controller/dist/`, which is
build output rather than tracked source. The compiler runs only on this
computer: Ansible mirrors the compiled `dist/src/` tree onto the Pi, preserving
the folders so import specifiers stay valid, and the Pi keeps running plain ESM
under the Debian `nodejs` package with no build tooling installed. Run
`make build` (or `pnpm --filter pimus-controller build`) before provisioning.

`controller/test/` mirrors the same folders and exercises the shared state,
action catalog and dispatch, rendering helpers, and ReSpeaker USB protocol
without requiring either physical device. Every dependency is pinned to an exact
version in `controller/package.json`, which is the only manifest the Pi
receives: it installs those pins with `npm install --omit=dev --omit=peer`, so
TypeScript and the type packages never reach it. Development on this computer
uses the pnpm workspace at the repository root instead.

## `playground`

A local debug environment for the controller, run with `make playground`. It has
its own `package.json` and compiles `controller/src/` alongside `playground/src/`
so it drives the real modules, replacing only the outermost boundaries: the
Stream Deck+ becomes a canvas in the browser, the LVA and audio-manager sockets
become loopback servers speaking the same protocols, and the ReSpeaker LED ring
becomes a drawing. `playground/ui/index.html` is the
page. Nothing here ships to the Pi, and `make test` does not build it — see
[docs/playground.md](../docs/playground.md).

## `audio-manager`

The long-running Python daemon in `audio-manager/src/audio_manager/` makes
HiFiBerry the default output, selects the XVF3800 microphone, and maintains
aux, USB audio, the Sendspin/USB background bus, ducking gain, and
acoustic-echo-reference PipeWire routes. Its unit tests are colocated in
`audio-manager/test/`.

`daemon.py` holds the reconcile loop and owns one object per concern:
`buses.py` (the background and voice null sinks and their bridge gains),
`routes.py` (the switchable inputs), `voice_capture.py`, `aec.py`, `output.py`
(the pinned output sink), `usb_volume.py`, and `modules.py` (every PipeWire
module the daemon loaded). `pactl.py`, `usb_gadget.py`, and `process.py` are
the command boundary, `graph.py` the cached view of the graph they read, and
`control_server.py` plus `commands.py` the Unix control socket the controller
speaks to. It runs as `python3 -m audio_manager`.
