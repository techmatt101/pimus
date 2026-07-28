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
    assets/fonts/        The bundled text face, deployed beside the modules
    src/                 TypeScript controller modules (.mts)
      actions/           Action catalog: specs, validation, voice/HA behaviour
      audio/             Audio manager socket, volume, ducking
      home-assistant/    HA WebSocket client, entity cache, entity reading,
                         and the notification queue automations push to
      remote/            The authenticated LAN WebSocket server other
                         computers push REMOTE-page tile faces to
      streamdeck/        Stream Deck lifecycle, bindings, drawing, and icons
        dials/           One Dial class per file (a knob's behaviour + readout)
        screens/         One Screen class per file (a full touch-strip face)
        tiles/           One Tile class per file (key behaviour + face)
      voice/             LVA WebSocket and ReSpeaker LEDs
    test/                A few high-level behaviour tests (.mts); see Validation
    dist/                Compiled .mjs output; build artifact, not tracked
    package.json
    tsconfig.json
  audio-manager/
    src/audio_manager/   PipeWire reconciliation daemon, run as a package
    test/                Python unit tests
  playground/            Development-only debug environment; never deployed
    src/                 Fake deck, LVA, audio manager, wpctl, LEDs, web server
    ui/                  The browser page the fake deck is drawn on
  remote-demo/           Development-only example client for the controller's
                         remote-tile socket; runs on the control computer
tools/                   Development-only code generators
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
- Every upstream is pinned: release versions in the inventory
  (`voice_assistant_version`, `sendspin_version`), and a commit plus per-file
  checksums for `xvf_host` (no upstream releases exist), generated into
  `ansible/roles/smartamp/vars/main.yml`. `make update-versions` refreshes
  them all and is the only way the generated vars file is written; never
  hand-edit it, and never point a download at a moving branch.
- Node apps are a pnpm workspace (`pnpm-workspace.yaml`, root `pnpm-lock.yaml`)
  on the control computer only. Every controller dependency is pinned to an
  exact version in `apps/controller/package.json`, because that file is the only
  manifest the Pi receives and it installs with plain `npm install`.
  `apps/playground` must pin the identical versions; `make test` enforces it.
- Service relationships are documented in `docs/architecture.md`.
- The hostname is `office-amp` and is managed by Ansible.

When adding a setting, update the inventory defaults, generated template,
runtime validation, and relevant documentation together.

## Implementation conventions

### Node controller

- Controller code is essentially comment-free: a comment is treated as a sign
  the code should be refactored to read on its own. The only comments that stay
  are short notes on genuine quirks — hardware behaviour (the strip only
  reports a tap on finger-lift, the deck retains its last image), external
  systems (Home Assistant and Music Assistant reporting habits, LVA and XMOS
  firmware protocol details), and non-obvious correctness constraints
  (`snapshot()` must copy, effect written last). Do not add narration, module
  header essays, or JSDoc that restates a name or type; when tempted to
  explain code with a comment, rename or extract instead. The Python audio
  manager and Ansible keep their explanatory comments — that side is
  magic-heavy and harder to make self-describing.
- Write ESM `.mts` modules compiled to `.mjs` output that runs on Node
  `>=22.18`. Do not use language or library features newer than the `ES2022`
  target; the Pi runs NodeSource's Node 24 LTS `nodejs` package, installed by
  Ansible (Debian's own package is too old for the native JPEG encoder).
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
  `home-assistant/`, `remote/`, `streamdeck/`, and `voice/`, with `index.mts`,
  `config.mts`, `state.mts`, and `types.mts` at the root.
- Home Assistant is reached over its WebSocket API with a long-lived token
  (`home-assistant/client.mts`). Tiles depend on the `HomeAssistantService`
  interface, never the client, and a deployment with no URL configured gets
  `createOfflineHomeAssistant()` so the layout never branches on whether the
  integration exists. A key that reads Home Assistant must draw three states —
  on, off, and unknown — so an unreachable instance never looks like a device
  that is simply switched off. Entity ids belong in `streamdeck/layout.mts`
  beside the keys that use them, not in inventory; the URL is the only inventory
  setting.
- Secrets are never stored in this repository and never templated. The Home
  Assistant and remote-tile tokens are hand-written on the Pi in
  `/etc/smartamp/secrets.env`, which the controller's systemd unit loads into
  its environment and `config.mts` folds into the parsed configuration; a
  feature that is switched on but has no token fails preflight with the key
  named. Do not add a token to inventory, `controller.json.j2`, or an Ansible
  Vault file.
- `actions/catalog.mts` is the single source of truth for the control surface.
  Declare a new action there (a voice action's `run` behaviour lives in its
  catalog entry), add it to `docs/controls.md`, then bind it in
  `streamdeck/layout.mts`. A default `ActionTile`'s colour and label feedback
  belongs in the catalog entry's `indicator`, not in the renderer.
- Each Stream Deck key is a `Tile` — an interface in
  `streamdeck/tiles/tile.mts`, with one implementing class per file in
  `streamdeck/tiles/`. A tile owns what pressing it does and how it renders its
  own face; the layout factory (`ControllerServices`, `streamdeck/layout.mts`)
  injects each tile only the domain services it uses — the `ControlModel`, the
  `HomeAssistantService`, the `LvaSender`, the `AudioControls`, or the `clock` —
  not one bag of every service, and there is no central action dispatcher. A key
  that runs a command builds it from the matching binding builder in
  `streamdeck/bindings.mts` (`haBinding`, `voiceBinding`, `volumeBinding`,
  `routeBinding`), each closed over just that one service. Use `ActionTile` with
  a `Binding` for a fixed key;
  write a new `Tile` class (as `MediaTile` does for play/pause) when a key
  needs behaviour or stateful rendering — icons, styling, animation — the
  catalog indicator cannot express. Never push per-key rendering back into the
  renderer.
- A tile that reacts to changes or animates uses the lifecycle: `mount(host)`
  when it becomes visible on an attached deck, `unmount()` when hidden. While
  mounted it may hold state, subscribe to the `ControlModel` (`state.mts`), and
  repaint just its key via `host.invalidate()` — e.g. a timer for animation,
  accumulating the `deltaTime` its `draw(surface, deltaTime)` is handed into its
  own phase. `draw` takes only the surface and that delta: a tile reads the live
  state it paints from directly (its injected services, or the `ControlModel` it
  holds), never a passed-in context. A tile that needs true wall-clock time (the
  time of day, a countdown to an instant) reads the injected `clock` service so a
  test can pin it. Drop every timer and subscription in `unmount`.
- Each dial is a `Dial` — an interface in `streamdeck/dials/dial.mts`, with one
  implementing class per file in `streamdeck/dials/`, exactly as tiles are
  arranged. A dial owns what turning and pressing it does and what it reads out;
  `detail(context)` is required, so no code outside a dial ever infers a readout
  from what the dial happens to be bound to. Dials do not paint: the four share
  one face drawn by `screens/dial-screen.mts`. Use `ActionDial` for a knob that
  can be told its readout; write a new class when it must work one out.
- Three of the four dials are fixed (`VolumeDial`, `MediaDial`, and a spare
  `ActionDial`); the fourth is the shared `DynamicDial`, which controls whichever
  entity a key last handed it. A key claims it by taking `dial` in its config and
  calling `controlEntity()` as it is pressed; what turning does comes from the
  entity's own domain, which `DynamicDial` derives itself, exactly as
  `EntityToggleTile` derives its toggle service. Add a domain by adding a row to
  `DIAL_DOMAINS` (in `dynamic-dial.mts`) and its stepping actions to the catalog
  — do not give a device its own dial.
- The touch strip is one full-width display, not four dial labels. `TouchStrip`
  (`streamdeck/strip.mts`) owns which `Screen` (`streamdeck/screens/`, one class
  per file) is showing: the dial being turned wins for a short hold, then a live
  notification, then the resting now-playing face. A screen paints the whole
  800x100 strip and may use the same `mount`/`unmount` lifecycle a tile does,
  including asking for animation frames; keep strip rendering there rather than
  in the renderer, exactly as for keys.
- Home Assistant automations push a message to the strip by firing the
  `smartamp_notify` event (`home-assistant/notifications.mts`), read over the
  existing WebSocket. Notifications are moments, not states: do not give one a
  helper entity, and do not add an inbound HTTP listener to the Pi for them.
- The Stream Deck layout is compiled in at `streamdeck/layout.mts` as
  `createLayout(services)`, not in inventory. Each page is a fixed named
  `PageGrid` (`streamdeck/grid.mts`) of tiles; the grid geometry,
  physical-key mapping, and dial shape live in `grid.mts`. Only the
  `streamdeck_enabled` deployment flag lives in Ansible.
- Tiles and screens paint onto a `Surface` (`streamdeck/surface.mts`), a
  lightweight holder for a Skia canvas (`@napi-rs/canvas`) and its 2D context.
  The helpers for the things every face repeats — `text`, `icon`, `bar`,
  `verticalGradient`, `clipped` — are free functions in that module taking the
  surface first (`text(surface, …)`), so the class stays minimal; only `reset`,
  `fill`, and `snapshot` live on it. `surface.ctx` is the real 2D context: reach
  for it directly rather than adding a helper for a one-off path, gradient, or
  clip. A face is RGBA and `snapshot()` must copy, because the canvas is reused
  for the next key.
- Icons are Hugeicons SVGs generated into `streamdeck/icon-set.mts` by
  `make icons` and committed. The artwork comes from `@hugeicons/core-free-icons`,
  a devDependency of the workspace root only: never add an icon package as a
  controller dependency, so the Pi keeps receiving none. Never hand-edit the
  generated module; add a line to `tools/generate-icons.mjs` and regenerate.
  Icon artwork strokes in `currentColor`, so a tile tints per state rather than
  getting its own glyph.
- Text is drawn in the font bundled at `apps/controller/assets/`, registered
  explicitly at startup. Pi OS Lite has almost no fonts, so never rely on a
  system face; `make build` copies `assets/` into `dist/` and Ansible deploys it
  beside the modules, which is what keeps the relative path valid on the Pi.
- Keep shared display/voice state in `state.mts`; the `ControlModel` there is
  the change-notification surface — mutate state, then `notify()`.
- Treat USB and WebSocket disconnects as normal. Log, retain useful state, and
  reconnect without terminating the daemon.
- Keep hardware access injectable so tests run without a Stream Deck or
  ReSpeaker attached.
- Keep `voice/xvf3800-device.mts` limited to the vendor protocol and USB
  transport; which appearance a voice state should show belongs in
  `voice/respeaker.mts`. The state-to-appearance map itself is compiled in at
  `voice/led-states.mts` (built with the `Leds` helpers from
  `voice/led-appearance.mts`), exactly as the deck layout is; only the
  `respeaker_led_enabled` flag and `respeaker_led_brightness` live in
  inventory. Do not reintroduce LED styling as deployed configuration.
- Preserve the XVF3800 vendor-control protocol and the `2886:001a` device match
  when changing LED behavior.

### Python apps

- Keep the audio manager focused on PipeWire graph reconciliation and gain on
  graph-owned routes. Voice-event policy stays in the Node controller.
- Prefer the Python standard library unless a dependency has a clear runtime
  benefit and is provisioned explicitly by Ansible.
- The audio manager is the `audio_manager` package, run as `python3 -m
  audio_manager` with its parent directory on `PYTHONPATH`. `daemon.py` owns
  the reconcile order and nothing else; each concern it drives (a bus, the
  routes, voice capture, the AEC reference, the USB volume agreement, the
  control socket) lives in its own module and holds its own state. Reach the
  outside world through `process.run`, `pactl`, and `usb_gadget`, and read the
  graph through the cached `Graph`, so tests patch one seam. Anything that
  mutates the graph goes through `ModuleRegistry`, which invalidates that
  cache. Adding a module means adding it to the deployed list in
  `roles/smartamp/tasks/audio.yml` automatically — it globs `*.py` — but a new
  top-level package would need its own task.

### Ansible

- Tasks must be idempotent and feature flags must be reversible. Disabling a
  feature should stop stale services and remove configuration that would remain
  active or misleading.
- Use handlers to coalesce service restarts and daemon reloads.
- A shell script that only substitutes scalar values is a plain file in
  `roles/smartamp/files/scripts/`, deployed with `copy`, and its values are
  injected through its systemd unit's `Environment=` lines (quote any value
  with spaces). This keeps the script lintable: `make test` runs `shellcheck`
  over that folder. Reserve `.sh.j2` templates for scripts whose structure is
  genuinely conditional (loops, `{% if %}`), such as `smartamp-doctor.sh.j2`.
  When a value moves into a unit's `Environment=`, make sure that unit's task
  notifies whatever a change to the value requires (a reboot for the USB
  gadget, a service restart for HiFiBerry).
- Run long-lived processes as the restricted `smartamp` service account, not
  root. Grant hardware access through narrow group/udev permissions.
- Every package entry and non-obvious task needs a nearby comment explaining
  what it provides and why this project needs it.
- The Pi has npm and no pnpm; do not add one. Deploy the controller under
  `/opt/smartamp/controller` and install its exact pins with
  `npm install --omit=dev --omit=peer`. Avoid global npm installs.
- Deploy the compiled `controller/dist/src/` tree, never the `.mts` sources, and
  preserve its folders on the Pi so import specifiers stay valid. The Pi gets no
  TypeScript toolchain; `make build` compiles on the control computer, and
  provisioning fails with an instruction if that output is missing.

## Validation

Run the complete local check before considering a code or provisioning change
finished:

```sh
make test
```

This compiles Python, type-checks and compiles the TypeScript controller, runs
Python and Node tests, and performs an Ansible syntax check without contacting
the Pi. A type error fails the build before any test runs.

For controller dependency changes, pin the exact version in both
`apps/controller/package.json` and `apps/playground/package.json`, then run:

```sh
pnpm install                   # refresh the workspace lockfile
make test
pnpm --filter pimus-controller audit --prod
```

The Pi resolves those pins itself with `npm install --omit=dev --omit=peer`, so
transitive versions there are not fixed by the workspace lockfile. Keep the
direct pins exact, and prefer dependencies with shallow trees.

Keep tests deterministic and hardware-free. Use injected fake USB, HID,
WebSocket, process, and filesystem boundaries where needed.

The controller test suite is deliberately small (a stance the user may revisit
later): a few high-level behaviour tests covering how the amp, voice pipeline,
and speaker work — ducking, the audio-manager socket, volume, shared voice/media
state, the LVA connection, and voice-state LED behaviour. This is not a
production app, so do not add fine-grained unit tests around Stream Deck display
logic (tiles, dials, screens, rendering, layout) or other presentation code;
the strict type check is the guard there. When touching core audio or voice
behaviour, extend the existing high-level tests rather than adding new
narrowly-scoped ones.

`apps/playground` is deliberately outside `make test`, which never installs it.
It compiles `apps/controller/src` with the controller's own strict settings, so
after changing a controller module's shape also run:

```sh
make playground        # or: pnpm --filter pimus-playground typecheck
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
- The XVF3800 USB capture is two DSP outputs, not stereo: channel 0 is the
  Conference stream (tuned for human listeners), channel 1 the ASR stream the
  voice assistant must hear. Keep the audio manager's mono ASR remap source and
  the voice unit's hardcoded single-channel capture: recording the device
  directly downmixes the two streams, and a second LVA channel would be
  forwarded to Home Assistant as a far-end echo reference, which on this
  device it is not.
- Device discovery must use stable properties or USB IDs, not ALSA card numbers
  that change with enumeration order.

## Working practices

- Preserve unrelated user changes in a dirty worktree.
- Update README/docs when architecture, setup, controls, or troubleshooting
  behavior changes.
- Do not commit unless the user asks. When asked, run the relevant validation
  first and use a concise commit message describing the completed outcome.
