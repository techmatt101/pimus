# Controller playground

A local debug environment for `smartamp-controller`. It runs the real controller
on your own machine with every piece of hardware and every remote service
replaced by a fake, and draws the Stream Deck+ in a browser.

```sh
make playground
```

The page opens at <http://127.0.0.1:8787/>. Stop it with `Ctrl-C`.

Nothing here touches the Pi, and the playground is never deployed: it is its own
app under `apps/playground/`, outside the tree Ansible copies.

## What is real and what is fake

Only the outermost boundary is replaced. Everything above it is the controller's
own code, imported straight from `apps/controller/src/`:

| Replaced | By | Still real |
| --- | --- | --- |
| Stream Deck+ over USB HID | a canvas in the browser | the deck loop, reconnects, dispatch queue, paging, tiles and their `mount`/`unmount`, the renderer and its bitmaps |
| LVA peripheral WebSocket | a loopback WebSocket server | `LvaClient`, its reconnect, the action catalog, voice-state handling |
| Audio manager Unix socket | a Unix socket server speaking the same protocol | `AudioManagerClient`'s optimistic route cache, its re-assert on reconnect, ducking |
| `wpctl` | a number standing in for the sink | `runVolumeCommand`'s argument vectors and the output monitor poll |
| ReSpeaker XVF3800 USB LEDs | a ring drawn in the state panel | `ReSpeakerController`'s state-to-appearance mapping and write de-duplication |
| Home Assistant | a house that responds to service calls | every tile's entity watch and `mount`/`unmount`, the catalog's service composition, the unknown-state faces |

The Home Assistant fake replaces the whole `HomeAssistantService` rather than
the socket under `HomeAssistantClient`: the protocol client has its own tests,
and what the playground is for is watching the keys. In exchange it can do what
a real house does — pressing the fan key turns the fan on, the timer really
counts down, and the lights dial moves the brightness it reports back.

The controller configuration is written out and then read back through the real
`loadConfig`, so the playground also exercises the validation that
`controller.json` has to pass on the Pi.

## Using it

- **Keys** — click one to press it, or use number keys `1`-`8`. The faces are
  the actual 120×120 bitmaps the renderer produced, pixel for pixel. With more
  than one page the bottom corners are previous/next, exactly as on the device.
- **Dials** — `◀`/`▶` turn, the knob presses, and scrolling over a dial turns
  it. Clicking the touch strip presses the dial under that point.
- **Inject** — pushes a voice event as if Home Assistant had sent it: wake word,
  timer ringing, media playing, mute, or the assistant going offline. Pressing
  the voice key also plays a scripted pipeline (wake → listening → thinking →
  speaking → idle) so ducking, LEDs and key colours move on their own; untick
  **simulate pipeline** to drive every step by hand instead.
- **Fault injection** — unplug the deck, plug it back in, or drop either socket
  to watch the reconnect paths run. An unplug is delivered the way a real one
  is: an error on the open handle plus an empty device list.
- **Event log** — every command the controller sends, every event it receives,
  and the local decisions in between, colour-coded by module. The same lines go
  to the terminal, so the playground is still useful with the browser closed.
- **Home Assistant** — change an entity from "somewhere else", the way the app
  or an automation would, so you can watch a key follow state it did not set
  itself. **toggle Home Assistant** under fault injection drops the connection,
  which is how to see the unknown-state faces.
- **State** — the shared control state, the audio manager's routes, whether
  background audio is ducked, the LED appearance the ReSpeaker would show, and
  every Home Assistant entity the keys read.

Options: `--port=<n>` to move the web server, `--no-open` to skip launching a
browser. Pass them through npm, e.g. `npm start -- --port=9000`.

## Working on the layout

`make playground` compiles the controller sources before it starts, so a change
to `streamdeck/layout.mts`, a tile, or the action catalog is on screen a couple
of seconds later. A mistyped route or volume command still fails to compile.

Because the playground compiles those sources with the same strict settings as
the controller's own build, it is also a fast check that a refactor did not
break the wiring — but it is **not** covered by `make test`, which never
installs this app. After changing a controller module's shape, run
`make playground` (or `cd apps/playground && npm run typecheck`) as well.

The dependency versions in `apps/playground/package.json` must match
`apps/controller/package.json`; the playground loads the controller's modules,
so it needs the same `ws`, `usb`, and Stream Deck packages.

## What it cannot tell you

The playground proves control-surface logic, not audio. There is no PipeWire
graph, no XVF3800 firmware, and no real timing: the fake audio manager only
flips booleans, and a "ducked" indicator means the request was made, not that
anything got quieter. Use `make verify` and `smartamp-doctor` for the parts that
only exist on the Pi.
