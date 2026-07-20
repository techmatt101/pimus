# Pimus development guide

## Project purpose

Pimus provisions `office-amp`, a Raspberry Pi 5 audio and voice endpoint built
from a HiFiBerry DAC2 ADC Pro + AAmp60, ReSpeaker XVF3800, and Elgato Stream
Deck+. It targets a fresh 64-bit Raspberry Pi OS Lite installation.

Home Assistant, Music Assistant, and LMS run on another machine. This repository
must remain a lightweight client: do not add Docker, a local HA/music server, or
an OS-image build pipeline unless the user explicitly changes that scope.

## Runtime architecture

Keep these boundaries clear:

- `smartamp-controller` is the long-running Node app. It owns Stream Deck input
  and rendering, ReSpeaker LED USB commands, the Linux Voice Assistant peripheral
  WebSocket, and shared control-surface state.
- `smartamp-audio-manager` is a separate long-running Python daemon. It
  continuously reconciles the PipeWire graph, default devices, aux/USB
  loopbacks, the duckable Squeezelite/USB background bus, and the XVF3800
  acoustic-echo-cancellation reference.
- Linux Voice Assistant and Squeezelite are external upstream applications
  installed and configured by Ansible; do not duplicate their logic locally.

The Node controller is the single owner of physical control-surface behavior.
Do not reintroduce separate Stream Deck and ReSpeaker controller services.

## Repository layout

Each deployable app owns its source and tests:

```text
apps/
  controller/
    src/                 TypeScript controller modules (.mts)
    test/                Hardware-free Node tests (.mts)
    dist/                Compiled .mjs output; build artifact, not tracked
    package.json
    package-lock.json
    tsconfig.json
  audio-manager/
    src/                 PipeWire reconciliation daemon
    test/                Python unit tests
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
- Route configured actions through `actions.mts` and keep shared display/voice
  state in `state.mts`.
- Treat USB and WebSocket disconnects as normal. Log, retain useful state, and
  reconnect without terminating the daemon.
- Keep hardware access injectable so tests run without a Stream Deck or
  ReSpeaker attached.
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
- Deploy the compiled `controller/dist/src/*.mjs`, never the `.mts` sources. The
  Pi gets no TypeScript toolchain; `make build` compiles on the control
  computer, and provisioning fails with an instruction if that output is
  missing.
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
