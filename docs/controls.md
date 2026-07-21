# Stream Deck controls

Every action a Stream Deck key or dial can perform, and where to change the
layout.

- **The layout** — which key and dial does what — lives in
  `apps/controller/src/streamdeck/layout.mts`. This is the file you edit. It is
  a TypeScript file, so it is type-checked and you can use the `voice`, `route`,
  and `volume` builders and ordinary variables to keep it readable.
- **Behaviour** lives in `apps/controller/src/actions/catalog.mts`, the single
  source of truth for what an action does, how it is validated, and how a key
  lights up while its target is active.
- Whether a unit drives a deck at all is the `streamdeck_enabled` flag in
  `ansible/inventory/group_vars/all.yml`.

After editing the layout, run `make deploy-controller` (or `make provision`) to
compile and push it. A mistyped `route`/`volume` command is a compile error, and
`make test` rejects any key or dial the catalog does not understand before it
can ship.

To see a change before it reaches the Pi, run `make playground`: it runs the
real controller on this computer against fake hardware and draws the deck,
pressable, in a browser. See [playground](playground.md).

## Hardware

The Stream Deck+ has an **8-key grid** (4 columns × 2 rows) and **4 dials**. Each
dial binds three separate actions: `left` (counter-clockwise), `right`
(clockwise), and `press`. Pressing the LCD strip above a dial triggers that
dial's `press` action.

## Pages

The keys are paged; the dials are not. With more than one page the two
bottom-corner keys become previous/next navigation and each page fills the
remaining six slots:

```text
[ topLeft ][ topMidLeft ][ topMidRight ][ topRight ]
[   PREV   ][ bottomLeft ][ bottomRight ][   NEXT   ]
```

A page is a fixed grid of named slots, not a list — you read where each tile
sits directly. The nav keys show an arrow and the name of the page they move to,
and paging wraps around at either end. Because the dials keep their bindings on
every page, volume and the aux/usb routes are always one turn away whichever page
is showing. A layout with a single page shows no nav keys, and its tiles keep the
same grid positions — adding a second page never reshuffles the keys already
placed. Any slot may be left out; it renders blank.

## Tiles

Each key is a **tile** — a class implementing the `Tile` interface, one class
per file in `apps/controller/src/streamdeck/tiles/`. A tile owns what pressing
it does and how it draws its 120×120 face. Tiles are created by the layout
factory (`createLayout(services)`) with the controller's services injected, so
a tile carries its behaviour with it instead of handing a description to a
central dispatcher:

- `ActionTile` (`tiles/action-tile.mts`) is the default: a fixed label and
  colour that runs one binding (a declarative action paired with its
  behaviour, built by the `voice`, `volume`, `route`, and `webhook` builders in
  `streamdeck/bindings.mts`). Its active-state feedback comes from the bound
  action's catalog indicator (see below), so most keys need nothing more than
  `key('LABEL', '#colour', binding)` in the layout.
- A key that needs richer behaviour or stateful rendering is its own `Tile`
  class built on the injected services. `MediaTile` (`tiles/media-tile.mts`)
  is the first: a single play/pause button that toggles the player itself,
  draws a play triangle or pause bars, colours itself from the playback state,
  and gently pulses while playing. New dynamic keys (icons, per-state styling,
  animation) belong in their own `Tile` class rather than in the shared
  renderer.

Tiles have a lifecycle. `mount(host)` is called when a tile becomes visible on
an attached deck and `unmount()` when its page navigates away or the deck
disconnects. While mounted a tile may keep its own state, subscribe to the
`ControlModel` (`state.mts`) to react to changes, and call `host.invalidate()`
to repaint just its own key. Ordinary repaints are event-driven — any model
change schedules a full redraw, debounced at 50 ms — so an **animated** tile
runs its own timer between state changes: `MediaTile` subscribes to the model,
starts a 150 ms pulse timer while the player is playing, and derives the
animation phase from `context.now` so its render stays a pure function. Every
timer and subscription must be dropped in `unmount`.

## Voice actions — `type: lva`

Sent to the Linux Voice Assistant peripheral socket.

| Command | Effect |
| --- | --- |
| `start_listening` | Start a voice pipeline, the same as speaking the wake word. |
| `mute_toggle` | Toggle the microphone mute. Tracks the mute state reported by LVA. |
| `media_toggle` | Play or pause the media player. |
| `stop` | Stop everything at once: timer ringing, the pipeline, and media playback. |
| `stop_timer_ringing` | Silence a ringing timer, leaving media playback alone. |

```ts
key('VOICE', '#006064', voice('start_listening'))
```

Any other command is forwarded to LVA unchanged, so upstream features work
without a controller change. Forwarded commands get no local state tracking and
no key feedback; add them to the catalog when they need either.

## Master volume — `type: audio` with no `source`

Drives the PipeWire default sink through `wpctl`.

| Command | Effect |
| --- | --- |
| `up` | Raise the default sink by 5%, capped at 100%. |
| `down` | Lower the default sink by 5%. |
| `mute` | Toggle mute on the default sink. |

```ts
{ label: 'VOLUME', left: volume('down'), right: volume('up'), press: volume('mute') }
```

## Audio routes — `type: audio` with a `source`

Toggles a named route through the audio manager's control socket. `source` must
be a route the audio manager owns, currently `aux` or `usb`; it rejects names it
does not know.

| Command | Effect |
| --- | --- |
| `on` | Enable the named audio route. |
| `off` | Disable the named audio route. |
| `toggle` | Flip the named audio route on or off. |

```ts
key('AUX', '#4a148c', route('aux', 'toggle'))
```

## Home Assistant webhooks — `type: webhook`

POSTs to `<home_assistant_webhook_base>/<id>`. Set the base URL in
`home_assistant_webhook_base`; with no base configured the action does nothing.
No Home Assistant token is stored on the Pi.

```ts
key('MOVIE', '#37474f', webhook('movie_mode'))
```

## Nothing — `type: noop`

Does nothing. Use the `none()` binding to blank a dial direction you do not
want bound.

```ts
{ label: 'VOICE', left: none(), right: none(), press: voice('start_listening') }
```

## Key and dial feedback

An `ActionTile` reports its target's live state through the bound action's
catalog indicator, so a key changes colour and label without any extra
configuration. Everything else keeps the label and colour you configured.

| Bound action | While active |
| --- | --- |
| `lva` / `mute_toggle` | Label becomes `MIC OFF`, background red. |
| `lva` / `media_toggle` | Label becomes `PAUSE`, background green. |
| `lva` / `start_listening` | Background cyan while the pipeline is running. |
| `audio` route (`on`/`off`/`toggle`) | Label gains ` ON` or ` OFF`, background green when on. |

The `MediaTile` used on the MAIN page goes further than the `media_toggle`
indicator: it draws a play or pause icon and colours itself from the playback
state. That state-driven rendering lives in the tile (see [Tiles](#tiles)), not
in the catalog.

A dial's readout follows the actions bound to it rather than its position: a
dial with a master volume action shows the volume percentage or `MUTED`, a dial
with a route action shows `ON` or `OFF`, and anything else shows the voice
assistant state. Reordering the dials in `layout.mts` keeps each readout correct.

## Changing the layout

Edit `apps/controller/src/streamdeck/layout.mts`, then `make deploy-controller`.
The layout is built by `createLayout(services)` and its `pages` and `dials` are
ordinary TypeScript. Place a tile in a page slot with
`key('LABEL', '#colour', binding)`, or drop in a dynamic tile such as
`new MediaTile(services)`. Add a page by adding another `{ name, grid }` entry
to `pages`; each page's `grid` has the six named slots (`topLeft`,
`topMidLeft`, `topMidRight`, `topRight`, `bottomLeft`, `bottomRight`), and its
short `name` labels the nav keys.

## Adding a new action

1. Add an entry to the relevant table in `apps/controller/src/actions/catalog.mts`.
2. For a voice action, declare its `run` behaviour in the catalog entry itself.
   The compiler requires this — a catalogued action with no behaviour fails the
   build.
3. Document it in the table above; a test fails if it is missing here.
4. Bind it in `apps/controller/src/streamdeck/layout.mts`.
5. Run `make test`.
