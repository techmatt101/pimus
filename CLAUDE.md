# Pimus development guide

## Project purpose

Pimus provisions a fleet of Raspberry Pi audio and voice endpoints built from a
HiFiBerry DAC2 ADC Pro + AAmp60 or a HiFiBerry Amp100, a ReSpeaker XVF3800, and
optionally an Elgato Stream Deck+. It targets a fresh 64-bit Raspberry Pi OS
Lite installation on a Pi 5, a Pi 4 Model B, or a Pi Zero 2 W (which reaches its
USB devices through a self-powered hub). Three units are configured today:

- `office-amp` — Pi 4 Model B, DAC2 ADC Pro + AAmp60, Stream Deck+, USB sound
  card.
  The reference build and the only one with a deck or an aux input.
- `bedroom-amp` — Pi 4 Model B, Amp100, no deck.
- `kitchen-amp` — Pi Zero 2 W, Amp100, no deck, USB devices on a powered hub.

Every unit has a ReSpeaker and runs the voice assistant. A unit's hardware is
its `host_vars` file; nothing in the code branches on which room it is.

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
      streamdeck/        The optional deck addon, entered at control-surface.mts:
                         lifecycle, bindings, drawing, and icons
        dials/           One Dial class per file (a knob's behaviour + readout)
        screens/         One Screen class per file (a full touch-strip face)
        tiles/           One Tile class per file (key behaviour + face)
      voice/             LVA WebSocket and ReSpeaker LEDs
    test/                A few high-level behaviour tests (.mts); see Validation
    dist/                Build artifact, not tracked: src/ is tsc's module per
                         source, bundle/ is the three modules the Pi is sent
    package.json
    tsconfig.json
  audio-manager/
    src/audio_manager/   PipeWire reconciliation daemon, run as a package
      control/           The Unix socket the controller drives it through:
                         the transport, and the command vocabulary
      system/            The command-line boundary: process, pactl, amixer,
                         parec, and the monitors that read a child's lines
      usb/               What the daemon keeps agreed with a computer plugged
                         into the audio gadget: its state, and its volume
      xvf3800/           The two paths serving the ReSpeaker's DSP rather than
                         the speakers: its ASR capture, and its echo reference
    test/                Python unit tests
  playground/            Development-only debug environment; never deployed
    src/                 Fake deck, LVA, audio manager, wpctl, LEDs, web server
    ui/                  The browser page the fake deck is drawn on
  remote-demo/           Development-only example client for the controller's
                         remote-tile socket; runs on the control computer
tools/                   Development-only generators and the controller bundler
ansible/
  inventory/
    hosts.yml            The units, one entry per amp
    group_vars/all.yml   Settings shared by every amp
    host_vars/           One file per unit: only what makes it that unit
  playbooks/             Provisioning and verification entry points
  roles/smartamp/        Tasks, handlers, and generated templates
docs/                    Architecture, configuration, troubleshooting
```

Do not create a generic top-level `src/` or `tests/` directory. Put code and
tests inside the app that owns them.

## Sources of truth

- User configuration lives in `ansible/inventory/group_vars/all.yml`, which
  holds the conservative shared answer, and `ansible/inventory/host_vars/`,
  where each unit declares only what differs — its HiFiBerry board, whether a
  deck is attached, its names, its power flags. Do not copy a whole settings
  file per unit, and do not push a room's specifics into `all.yml`. A setting
  every amp shares gets a default and a comment in `all.yml`; a unit that
  cannot honour it fails preflight by name.
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
- A unit's hostname is its inventory name, set on the Pi by Ansible from
  `smartamp_hostname`; adding a host to `hosts.yml` is what names it.

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
- The Stream Deck is an addon, not a given. `streamdeck/control-surface.mts` is
  the subsystem's one entry point — layout, renderer, deck loop, panel sleep,
  power button, sleeping USB power, and the remote-tile listener — and
  `index.mts` reaches it through a dynamic import taken only when
  `streamdeck.enabled` is on. Nothing else may import `streamdeck/` or
  `remote/`, because those two directories are the only ones allowed to touch
  the manifest's `optionalDependencies` (`@napi-rs/canvas`,
  `@elgato-stream-deck/node`, `@julusian/jpeg-turbo`): a deck-less Pi is sent
  neither those modules nor those packages, so a static import anywhere else
  would crash a working deployment at startup. That dynamic import is also the
  bundler's split point, and `tools/bundle-controller.mjs` fails the build if a
  module from either directory — or one of those three packages — reaches the
  core bundle, so breaking the rule stops `make build` rather than a Pi. Anything
  the surface needs from the rest of the controller arrives through
  `ControlSurfaceServices`; do not reach back the other way.
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
  `surface.mts` resolves that path two directories up from its own module, so the
  depth it is deployed at is load-bearing: registering a font that is not there
  raises nothing and the deck simply draws blank labels. The bundler asserts the
  module lands in the deck bundle, and `make test` asserts the family registered.
- Keep shared display/voice state in `state.mts`; the `ControlModel` there is
  the change-notification surface — mutate state, then `notify()`.
- Treat USB and WebSocket disconnects as normal. Log, retain useful state, and
  reconnect without terminating the daemon.
- Keep hardware access injectable so tests run without a Stream Deck or
  ReSpeaker attached.
- Keep `voice/xvf3800-device.mts` limited to the vendor protocol and USB
  transport; which face a voice state should show belongs in
  `voice/respeaker.mts`. The state-to-face map itself is compiled in at
  `voice/led-states.mts`, exactly as the deck layout is; only the
  `respeaker_led_enabled` flag and `respeaker_led_brightness` live in
  inventory. Do not reintroduce LED styling as deployed configuration.
- Each ring face is an `LedAnimation` — an interface in
  `voice/leds/animation.mts`, with one implementing class per file in
  `voice/leds/`, exactly as tiles and dials are arranged. A face draws itself:
  `ring(nowMs, signals)` answers with the colour of every LED, derived from the
  clock and the live levels rather than retained state, so a missed tick cannot
  drift an animation and a test can pin the clock. It declares `framePeriodMs`
  when it needs redrawing and `demand` when it paints from live audio, which is
  what keeps the microphone array unread and the voice bus unmetered for a face
  that is not showing. Do not add a description-of-a-face layer between the
  class and the frame; a new effect is a new class and a line in the state map.
  A face shown for a moment rather than for a state — the green blip that signs
  off a finished conversation — is still a class in `voice/leds/`, but is built
  with the instant it began by a factory beside the map (`conversationEndedFace`)
  and shown by `respeaker.mts` over whatever state is current. Keep its colour
  there with the rest; a moment is not an occasion to style a face elsewhere.
- The controller draws every face itself and asks the firmware only for `Ring`
  and `Off`. Do not reintroduce the firmware's breath, rainbow, solid, or
  direction-of-arrival effects: they cannot be driven from live audio, and they
  would put a second way of saying what the ring looks like beside the frames.
- Preserve the XVF3800 vendor-control protocol and the `2886:001a` device match
  when changing LED behavior. `types.mts` and `xvf3800-device.mts` record the
  device's full effect and command set even though only part of it is driven.

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
  outside world through the `system/` subpackage — `process.run`, `pactl`,
  `usb_gadget`, `parec`, and the `monitors` line readers — and read the graph
  through the cached `Graph`, so tests patch one seam. Every external binary the
  daemon runs is spawned from there and nothing in it imports the package above
  it; a module that decides policy does not belong in it. A caller passes what
  the command should say (the capture's rate, the device to meter) and keeps the
  argv itself out of its own file. Anything that mutates the
  graph goes through `ModuleRegistry`, which invalidates that cache. Adding a
  module or a subpackage means adding it to the deployed list in
  `roles/smartamp/tasks/audio.yml` automatically — it globs `*.py` beneath the
  package root and deploys each one at its relative path — but a new top-level
  package would need its own task.

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
  `npm install --omit=dev --omit=peer`, plus `--omit=optional` when
  `streamdeck_enabled` is off. That choice is recorded beside the manifest,
  because `npm ls` cannot see packages it was told to ignore and turning the
  deck off would otherwise never prune them.
- Deploy the bundled `controller/dist/bundle/` output, never the `.mts` sources
  and never the per-file `dist/src/` tree. `make build` compiles with `tsc` on
  the control computer and then rolls that output up with
  `tools/bundle-controller.mjs` into one module per deployment boundary —
  `index.mjs`, the `streamdeck/control-surface.mjs` addon, and the hashed
  `shared-*.mjs` chunk both import — each with a source map beside it. Copying
  75 modules one at a time was most of what a controller deploy spent its time
  on. Preserve the two-level layout on the Pi: the import specifiers between the
  bundles and the addon's font path both depend on it. The Pi gets no TypeScript
  toolchain, and provisioning fails with an instruction if the output is missing.
  A unit with no deck is sent neither the addon nor the bundled font, and the
  obsolete-module pass takes both off a Pi whose flag has just been turned off,
  along with the empty directories they leave behind. `dist/src/` stays the
  unbundled reference — the tests run against it, and it is what a bundled stack
  trace maps back to.

## Validation

Run the complete local check before considering a code or provisioning change
finished:

```sh
make test
```

This compiles Python, type-checks and compiles the TypeScript controller,
bundles it, runs Python and Node tests, checks the bundles, and performs an
Ansible syntax check without contacting the Pi. A type error fails the build
before any test runs, and so does a bundle that crossed a deployment boundary.

The tests import the `dist/src` modules; the Pi runs the bundles, so those are
checked as their own artifact. The entry is only parsed — importing it would
read `/etc/smartamp/controller.json` and start the daemon — while the deck
bundle is imported outright and its font family asserted. That check is the one
part of `make test` needing the deck's optional packages installed here.

For controller dependency changes, pin the exact version in both
`apps/controller/package.json` and `apps/playground/package.json`, then run the
commands below. A package only `streamdeck/` or `remote/` imports belongs in the
controller's `optionalDependencies`; the playground always draws, so it pins
every one of them as a plain dependency and `make test` compares both maps
against it.

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
make playground-check
```

Add fakes there rather than changing controller code to accommodate the
playground; it may only replace boundaries the controller already injects.

`make playground` and `make dev` are not checks: they start the fake amp and
run until interrupted. Never run either to validate a change — they never
return.

Commands such as `make provision`, `make check`, `make verify`, and `make doctor`
contact or change the real Pis, and run against every unit in the inventory
unless `LIMIT` names one (`make provision LIMIT=kitchen-amp`). Do not run them
unless the user asks for remote deployment/verification and the targets are
expected to be reachable. Provisioning can reboot a Pi when boot overlays
change.

## Hardware constraints

- What each supported board can do lives in `roles/smartamp/vars/boards.yml`,
  on two axes: the Raspberry Pi (matched from the device-tree model, published
  as `smartamp_board_caps`) and the HiFiBerry board (named by `hifiberry_board`
  in inventory, published as `smartamp_hifiberry_caps`). Anything
  board-conditional reads those facts; do not parse the model string again, and
  do not give a board its own task file. A setting the board cannot honour fails
  preflight by name rather than being silently dropped.
- The HiFiBerry board cannot be detected, because `force_eeprom_read=0` tells
  the firmware to ignore the HAT's EEPROM so the chosen overlay wins. Both
  supported boards enumerate as the same ALSA card id (`sndrpihifiberry`), so
  the card name proves nothing about which one is fitted.
- Only a board with an ADC has an analogue aux input. The Amp100 has none, so
  it gets no aux source in `audio.json` at all rather than a permanently
  unavailable one, and its ADC mixer controls are never written. The same holds
  for `usb` without the audio gadget: `audio.json` lists only the routes the
  hardware has, and both may be absent.
- That list is the one answer to which routes exist. The audio manager
  publishes the names it knows, the controller mirrors them as
  `AudioState.sources`, and a route key whose name is missing from a known list
  draws unavailable and does not run (`routeIndicator.isAvailable` in
  `actions/catalog.mts`). Do not add a second answer in `controller.json`, and
  do not make the compiled layout board-conditional. `routesKnown` is what keeps
  "the manager has not answered yet" from reading as "this unit has no routes".
- USB audio gadget mode turns the USB-C port into a peripheral connection; it
  can no longer be the normal PSU input. The HiFiBerry/AAmp60 stack must then
  power the Pi through GPIO. On a Pi 4B the host cable must have its power line
  cut as well: that board wires USB-C VBUS onto the same 5V rail as the GPIO
  header, with no PMIC to arbitrate. A Pi Zero 2 W has one USB data port for
  both roles, so it cannot be a sound card and still host the deck and the
  ReSpeaker: preflight refuses the flag, and the deck's USB key greys itself out
  on the route list that follows.
- The Pi, AAmp60, ReSpeaker, and Stream Deck+ need power-budget validation.
  Preserve under-voltage checks and recommend a powered USB hub if USB devices
  reset or the throttle flags are non-zero. A Pi 5 declares its GPIO supply with
  `PSU_MAX_CURRENT`; a Pi 4B has no such setting and a fixed ~1.2A USB-A budget;
  a Pi Zero 2 W requires a self-powered hub, so the budget is the hub's.
- A Pi 5 and a Pi 4B switch USB VBUS, ganged across every USB-A socket, but only
  the Pi 5 has a dedicated power button, so the button sleep/wake toggle is a Pi
  5 behaviour. On a Pi 4B the switch needs VL805 firmware 000137ad or newer, its
  ports are the internal hub's, listed for both the USB2 and USB3 halves because
  power only drops when both are switched, and a slept board with dark USB can
  only be woken by presence. A Pi Zero 2 W has no switchable port and its
  devices are hub-powered, so it sleeps the panel and nothing else.
- Only a board with a bootloader EEPROM has the halt/wake power flags. A Pi Zero
  2 W is a BCM2710 and boots from the card, so its key list is empty, `eeprom.yml`
  is skipped whole, and preflight names any power flag left on.
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
