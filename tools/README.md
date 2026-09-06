# Tools

Development-only programs and generators, run on the control computer and never
deployed to a Pi. `bundle-controller.mjs`, `generate-icons.mjs`, and
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

## `remote-demo`

An example client for the controller's remote-tile socket, run on the control
computer to push key faces onto a deck's REMOTE page. See
[docs/controls.md](../docs/controls.md#remote-tiles-from-another-computer).
