# Controller playground

A local debug environment for `smartamp-controller`. It runs the real controller
on your own machine with every piece of hardware and every remote service
replaced by a fake, and draws the Stream Deck+ in a browser.

```sh
make dev          # rebuilds and reloads as you edit — the one to use
make playground   # build once and run
```

The page opens at <http://127.0.0.1:8787/>. Stop it with `Ctrl-C`.

Nothing here touches the Pi, and the playground is never deployed: it is its own
app under `apps/playground/`, outside the tree Ansible copies.

## What is real and what is fake

Only the outermost boundary is replaced. Everything above it is the controller's
own code, imported straight from `apps/controller/src/`:

| Replaced                   | By                                              | Still real                                                                                                                 |
|----------------------------|-------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| Stream Deck+ over USB HID  | a canvas in the browser                         | the deck loop, reconnects, dispatch queue, paging, tiles and their `mount`/`unmount`, the renderer and the faces it paints |
| LVA peripheral WebSocket   | a loopback WebSocket server                     | `LvaClient`, its reconnect, the action catalog, voice-state handling                                                       |
| Audio manager Unix socket  | a Unix socket server speaking the same protocol | `AudioManagerClient`'s optimistic route cache, its re-assert on reconnect, ducking, the voice bus level, the sink mute     |
| ReSpeaker XVF3800 USB LEDs | a ring drawn in the state panel                 | `ReSpeakerController`'s state-to-appearance mapping and write de-duplication                                               |
| XVF3800 DSP microphone readouts | a speaker circling the array, talking in phrases | `MicSensor`'s levelling and direction hold, and the ripples `listenWave` paints from them                              |
| Home Assistant             | a house that responds to service calls          | every tile's entity watch and `mount`/`unmount`, the catalog's service composition, the unknown-state faces                |

One boundary is not faked at all: the remote-tile server is real code with no
hardware behind it, so the playground runs it on `ws://127.0.0.1:8470` with the
token `playground`. Point a client at it — for example

```sh
pnpm --filter pimus-remote-demo start -- --url=ws://127.0.0.1:8470 --token=playground
```

— and its keys appear on the REMOTE page of the browser deck, presses and
strip banners included.

The Home Assistant fake replaces the whole `HomeAssistantService` rather than
the socket under `HomeAssistantClient`: the protocol client has its own tests,
and what the playground is for is watching the keys. In exchange it can do what
a real house does — pressing the fan key turns the fan on, the timer really
counts down, and the dynamic dial moves the brightness, fan speed, or blind
position it reports back.

The controller configuration is written out and then read back through the real
`loadConfig`, so the playground also exercises the validation that
`controller.json` has to pass on the Pi.

## Using it

- **Keys** — click one to press it, or use number keys `1`-`8`. The faces are
  the actual 120×120 faces the renderer painted, pixel for pixel. With more
  than one page the bottom corners are previous/next, exactly as on the device.
- **Dials** — `◀`/`▶` turn, the knob presses, and scrolling over a dial turns
  it. Turning one takes over the touch strip above, which otherwise shows what
  is playing. Clicking the strip presses the dial under that point, or
  acknowledges a notification when one is showing. Dial 4 does nothing until a
  room key claims it: press `LIGHTS`, `FAN`, or `BLINDS` on the Room page and
  turn it to see what that key handed over.
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
  itself. **next track** changes what the strip rests on, and the notification
  buttons fire the same `smartamp_notify` event a real automation would.
  **toggle Home Assistant** under fault injection drops the connection, which is
  how to see the unknown-state faces.
- **State** — the shared control state, the audio manager's routes, whether
  background audio is ducked, the LED appearance the ReSpeaker would show, and
  every Home Assistant entity the keys read. The ring's two audio-driven states
  animate here: playing the scripted pipeline shows the listening ripples
  tracking a faked speaker around the array, and the speaking pulse riding a
  synthesised envelope the fake audio manager sends over the real socket.

Options: `--port=<n>` to move the web server, `--no-open` to skip launching a
browser. Pass them through pnpm, e.g.
`pnpm --filter pimus-playground start -- --port=9000`.

## Working on the layout

`make dev` is the loop to leave running. It watches the controller and
playground sources, recompiles on save, restarts the playground, and reloads the
open page — so a change to `streamdeck/layout.mts`, a tile, or the action
catalog is on screen a second or two after you save, with no click anywhere.
Editing `apps/playground/ui/index.html` reloads the page without a restart. A
mistyped route or volume command still fails to compile, and the error appears
in the same terminal while the last good build keeps running.

`make playground` does the same thing without the watchers: one build, one run.
Reach for it when you want a fixed build rather than a moving one.

The browser reconnects to the event stream on its own and reloads whenever it
finds a playground that has restarted underneath it, so nothing needs a manual
refresh and no second tab piles up.

Because the playground compiles those sources with the same strict settings as
the controller's own build, it is also a fast check that a refactor did not
break the wiring — but it is **not** covered by `make test`, which never builds
this app. After changing a controller module's shape, run `make dev` (or
`pnpm --filter pimus-playground typecheck`) as well.

Both apps are members of the repository's pnpm workspace, so one `pnpm install`
at the root covers them. The playground loads the controller's own modules, so
it must pin the same `ws`, `usb`, and Stream Deck versions its package.json
declares — `make test` fails if the two drift apart.

## What it cannot tell you

The playground proves control-surface logic, not audio. There is no PipeWire
graph, no XVF3800 firmware, and no real timing: the fake audio manager only
flips booleans, and a "ducked" indicator means the request was made, not that
anything got quieter. Use `make verify` and `smartamp-doctor` for the parts that
only exist on the Pi.
