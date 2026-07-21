# Pimus development guide

## Project purpose

Pimus provisions `office-amp`, a Raspberry Pi 5 audio and voice endpoint built
from a HiFiBerry DAC2 ADC Pro + AAmp60, ReSpeaker XVF3800, and Elgato Stream
Deck+. It targets a fresh 64-bit Raspberry Pi OS Lite installation.

Home Assistant and Music Assistant run on another machine. This repository
must remain a lightweight client: do not add Docker, a local HA/music server, or
an OS-image build pipeline unless the user explicitly changes that scope.

## Runtime architecture

Keep these boundaries clear:

- `smartamp-controller` is the long-running Node app. It owns Stream Deck input
  and rendering, ReSpeaker LED USB commands, the Linux Voice Assistant peripheral
  WebSocket, and shared control-surface state.
- `smartamp-audio-manager` is a separate long-running Python daemon. It
  continuously reconciles the PipeWire graph, default devices, aux/USB
  loopbacks, the duckable Sendspin/USB background bus, and the XVF3800
  acoustic-echo-cancellation reference.
- Linux Voice Assistant and Sendspin are external upstream applications
  installed and configured by Ansible; do not duplicate their logic locally.

The Node controller is the single owner of physical control-surface behavior.
Do not reintroduce separate Stream Deck and ReSpeaker controller services.

## Repository layout

Each deployable app owns its source and tests:

```text
apps/
  controller/
    src/                 TypeScript controller modules (.mts)
      actions/           Action catalog: specs, validation, voice/HA behaviour
      audio/             Audio manager socket, volume, ducking
      home-assistant/    HA WebSocket client, entity cache, entity reading
      streamdeck/        Stream Deck lifecycle, bindings, icons, and rendering
        tiles/           One Tile class per file (key behaviour + face)
      voice/             LVA WebSocket and ReSpeaker LEDs
    test/                Hardware-free Node tests (.mts), mirroring src/
      support/           Shared test doubles; the one folder not mirroring src/
    dist/                Compiled .mjs output; build artifact, not tracked
    package.json
    package-lock.json
    tsconfig.json
  audio-manager/
    src/                 PipeWire reconciliation daemon
    test/                Python unit tests
  playground/            Development-only debug environment; never deployed
    src/                 Fake deck, LVA, audio manager, wpctl, LEDs, web server
    ui/                  The browser page the fake deck is drawn on
ansible/
  inventory/             User-editable device configuration
  playbooks/             Provisioning and verification entry points
  roles/smartamp/        Tasks, handlers, and generated templates
docs/                    Architecture, configuration, troubleshooting
```

Do not create a generic top-level `src/` or `tests/` directory. Put code and
tests inside the app that owns them.

## Sources of truth

- User configuration lives in `ansible/inventory/group_vars/all.yml`.
- Runtime JSON and systemd units are generated from
  `ansible/roles/smartamp/templates/`; do not rely on hand-edited target files.
- Node dependencies must be declared and exactly locked in
  `apps/controller/package.json` and `package-lock.json`.
- Service relationships are documented in `docs/architecture.md`.
- The hostname is `office-amp` and is managed by Ansible.

When adding a setting, update the inventory defaults, generated template,
runtime validation, and relevant documentation together.

## Implementation conventions

### Node controller

- Write ESM `.mts` modules compiled to `.mjs` output that runs on Node
  `>=18.18`. Do not use language or library features newer than the `ES2022`
  target; the Pi runs the Debian `nodejs` package.
- Type checking is strict, including `noUncheckedIndexedAccess`. Prefer
  narrowing and explicit guards over `any` or non-null assertions.
- Declare shared configuration, voice-event, and device shapes in `types.mts`.
  Its configuration types mirror `controller.json.j2`; change both together.
- Depend on the narrow interfaces in `types.mts` (`LvaSender`, `LedDevice`,
  `UsbControlDevice`) rather than concrete classes, so modules stay free of
  circular imports and tests can inject plain objects.
- Keep `index.mts` as composition/root wiring; put device or domain logic in a
  focused module.
- Group modules by the boundary they own: `actions/`, `audio/`,
  `home-assistant/`, `streamdeck/`, and `voice/`, with `index.mts`,
  `config.mts`, `state.mts`, and `types.mts` at the root. Mirror the same
  folders under `test/`.
- Home Assistant is reached over its WebSocket API with a long-lived token
  (`home-assistant/client.mts`). Tiles depend on the `HomeAssistantService`
  interface, never the client, and a deployment with no token configured gets
  `createOfflineHomeAssistant()` so the layout never branches on whether the
  integration exists. A key that reads Home Assistant must draw three states —
  on, off, and unknown — so an unreachable instance never looks like a device
  that is simply switched off. Entity ids belong in `streamdeck/layout.mts`
  beside the keys that use them, not in inventory; only the URL and token are
  inventory settings.
- `actions/catalog.mts` is the single source of truth for the control surface.
  Declare a new action there (a voice action's `run` behaviour lives in its
  catalog entry), add it to `docs/controls.md`, then bind it in
  `streamdeck/layout.mts`. A default `ActionTile`'s colour and label feedback
  belongs in the catalog entry's `indicator`, not in the renderer.
- Each Stream Deck key is a `Tile` — an interface in
  `streamdeck/tiles/tile.mts`, with one implementing class per file in
  `streamdeck/tiles/`. A tile owns what pressing it does and how it renders its
  own face; tiles get the controller's services (`TileServices`,
  `streamdeck/bindings.mts`) injected by the layout factory, and there is no
  central action dispatcher. Use `ActionTile` with a `Binding` for a fixed key;
  write a new `Tile` class (as `MediaTile` does for play/pause) when a key
  needs behaviour or stateful rendering — icons, styling, animation — the
  catalog indicator cannot express. Never push per-key rendering back into the
  renderer.
- A tile that reacts to changes or animates uses the lifecycle: `mount(host)`
  when it becomes visible on an attached deck, `unmount()` when hidden. While
  mounted it may hold state, subscribe to the `ControlModel` (`state.mts`), and
  repaint just its key via `host.invalidate()` — e.g. a timer for animation,
  with the phase derived from `context.now` so render stays pure. Drop every
  timer and subscription in `unmount`.
- The Stream Deck layout is compiled in at `streamdeck/layout.mts` as
  `createLayout(services)`, not in inventory. Each page is a fixed named
  `PageGrid` (`streamdeck/grid.mts`) of tiles; the grid geometry,
  physical-key mapping, and dial shape live in `grid.mts`. Only the
  `streamdeck_enabled` deployment flag lives in Ansible; `layout.test.mts` and
  `tile.test.mts` validate the compiled layout and tiles against the catalog.
- Keep shared display/voice state in `state.mts`; the `ControlModel` there is
  the change-notification surface — mutate state, then `notify()`.
- Treat USB and WebSocket disconnects as normal. Log, retain useful state, and
  reconnect without terminating the daemon.
- Keep hardware access injectable so tests run without a Stream Deck or
  ReSpeaker attached.
- Keep `voice/xvf3800-device.mts` limited to the vendor protocol and USB
  transport; which appearance a voice state should show belongs in
  `voice/respeaker.mts`.
- Preserve the XVF3800 vendor-control protocol and the `2886:001a` device match
  when changing LED behavior.

### Python apps

- Keep the audio manager focused on PipeWire graph reconciliation and gain on
  graph-owned routes. Voice-event policy stays in the Node controller.
- Prefer the Python standard library unless a dependency has a clear runtime
  benefit and is provisioned explicitly by Ansible.

### Ansible

- Tasks must be idempotent and feature flags must be reversible. Disabling a
  feature should stop stale services and remove configuration that would remain
  active or misleading.
- Use handlers to coalesce service restarts and daemon reloads.
- Run long-lived processes as the restricted `smartamp` service account, not
  root. Grant hardware access through narrow group/udev permissions.
- Every package entry and non-obvious task needs a nearby comment explaining
  what it provides and why this project needs it.
- Avoid global npm installs. Deploy the controller under `/opt/smartamp/controller`
  and install its lockfile with `npm ci --omit=dev --omit=peer`.
- Deploy the compiled `controller/dist/src/` tree, never the `.mts` sources, and
  preserve its folders on the Pi so import specifiers stay valid. The Pi gets no
  TypeScript toolchain; `make build` compiles on the control computer, and
  provisioning fails with an instruction if that output is missing.
- Preserve the migration cleanup for the legacy `smartamp-peripherals` and
  `smartamp-streamdeck` units.

## Validation

Run the complete local check before considering a code or provisioning change
finished:

```sh
make test
```

This compiles Python, type-checks and compiles the TypeScript controller, runs
Python and Node tests, and performs an Ansible syntax check without contacting
the Pi. A type error fails the build before any test runs.

For controller dependency changes, also run:

```sh
cd apps/controller
npm ci                         # development tree, including TypeScript
npm test
npm ci --omit=dev --omit=peer  # the exact tree installed on the Pi
npm audit --omit=dev --omit=peer
npm ci                         # restore the development tree
```

Build and test need the development tree; `npm test` cannot run under
`--omit=dev` because that omits TypeScript. Install the production tree only to
confirm the runtime dependencies the Pi receives still resolve.

Keep tests deterministic and hardware-free. Use injected fake USB, HID,
WebSocket, process, and filesystem boundaries where needed.

`apps/playground` is deliberately outside `make test`, which never installs it.
It compiles `apps/controller/src` with the controller's own strict settings, so
after changing a controller module's shape also run:

```sh
make playground        # or: cd apps/playground && npm run typecheck
```

Add fakes there rather than changing controller code to accommodate the
playground; it may only replace boundaries the controller already injects.

Commands such as `make provision`, `make check`, `make verify`, and `make doctor`
contact or change the real Pi. Do not run them unless the user asks for remote
deployment/verification and the inventory target is expected to be reachable.
Provisioning can reboot the Pi when boot overlays change.

## Hardware constraints

- USB audio gadget mode turns the Pi 5 USB-C port into a peripheral connection;
  it can no longer be the normal PSU input. The HiFiBerry/AAmp60 stack must then
  power the Pi through GPIO.
- The Pi 5, AAmp60, ReSpeaker, and Stream Deck+ need power-budget validation.
  Preserve under-voltage checks and recommend a powered USB hub if USB devices
  reset or the throttle flags are non-zero.
- The XVF3800 playback endpoint carries the far-end AEC reference even though
  its physical speaker jack is unused. Do not remove that route as "unused."
- Device discovery must use stable properties or USB IDs, not ALSA card numbers
  that change with enumeration order.

## Working practices

- Preserve unrelated user changes in a dirty worktree.
- Update README/docs when architecture, setup, controls, or troubleshooting
  behavior changes.
- Do not commit unless the user asks. When asked, run the relevant validation
  first and use a concise commit message describing the completed outcome.
