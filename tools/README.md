# Tools

Development-only programs and generators, run on the control computer. Nothing
here runs as a service on a Pi; the one exception to "never deployed" is the
Pi half of `e2e`, a self-test copied onto each amp for `make e2e` to run. `bundle-controller.mjs`, `generate-icons.mjs`, and
`update-versions.mjs` are the generators `make build`, `make icons`, and
`make update-versions` run; the two directories below are apps of their own.

## `playground`

A local debug environment for the controller, run with `make dev` or
`make playground`. It has its own `package.json` and compiles `apps/controller/src/`
alongside `playground/src/` so it drives the real modules, replacing only the
outermost boundaries: the Stream Deck+ becomes a canvas in the browser, the LVA
and audio-manager sockets become loopback servers speaking the same protocols,
Home Assistant becomes a house that answers service calls, and the ReSpeaker
ring and DSP readouts become drawings. `playground/ui/index.html` is the page.
Nothing here ships to the Pi, and `make test` does not build it — see
[docs/playground.md](../docs/playground.md).

## `e2e`

`make e2e`, in two halves. `e2e/selftest/` is the Python package Ansible
deploys to every amp as `smartamp-selftest`: it drives every feature the unit
is configured with, one tier per module under `tiers/`, restores every level it
moves, and has `observe` modes the other half drives; its hardware-free tests
are in `e2e/test/`, run by `make test`. `e2e/src/e2e.mjs` runs here: it runs
that suite over SSH on each amp, then makes the checks only this computer can:
playing a tone into the amp's USB-C sound card with `sox`, firing the
`smartamp_notify` event at Home Assistant, having the voice satellite announce,
and streaming a served file to the Sendspin player, each watched for on the Pi.
Dependency-free Node; needs `HOME_ASSISTANT_TOKEN` for the Home Assistant
parts. Reports land in `e2e/reports/`, ignored by git. See
[docs/e2e.md](../docs/e2e.md).

## `remote-demo`

An example client for the controller's remote-tile socket, run on the control
computer to push key faces onto a deck's REMOTE page. See
[docs/controls.md](../docs/controls.md#remote-tiles-from-another-computer).
