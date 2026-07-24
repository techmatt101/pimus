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

The Stream Deck+ has an **8-key grid** (4 columns × 2 rows), **4 dials**, and an
800×100 **touch strip** above the dials. Each dial binds three separate actions:
`left` (counter-clockwise), `right` (clockwise), and `press`. Pressing the strip
above a dial triggers that dial's `press` action — unless a notification is
showing, in which case the tap acknowledges it (see [The touch
strip](#the-touch-strip)).

## Pages

The keys are paged; the dials are not. The **third dial pages the grid** — turn
it to move between pages — so every one of the eight keys is free to carry a
page's tiles:

```text
[ topLeft    ][ topMidLeft    ][ topMidRight    ][ topRight    ]
[ bottomLeft ][ bottomMidLeft ][ bottomMidRight ][ bottomRight ]
```

A page is a fixed grid of named slots, not a list — you read where each tile
sits directly. The page dial reads out the name of the page you land on, and
paging wraps around at either end. Because the dials keep their bindings on
every page, volume and transport are always one turn away whichever page is
showing — including the dial claimed on the ROOM page, which stays claimed while
you look at something else. Tiles keep the same grid positions across pages —
adding a page never reshuffles the keys already placed. Any slot may be left
out; it renders blank.

## Tiles

Each key is a **tile** — a class implementing the `Tile` interface, one class
per file in `apps/controller/src/streamdeck/tiles/`. A tile owns what pressing
it does and how it draws its 120×120 face. Tiles are created by the layout
factory (`createLayout(services)`) with the controller's services injected, so
a tile carries its behaviour with it instead of handing a description to a
central dispatcher:

- `ActionTile` (`tiles/action-tile.mts`) is the default: a fixed label and
  colour that runs one binding (a declarative action paired with its
  behaviour, built by the `voice`, `volume`, `route`, and `ha` builders in
  `streamdeck/bindings.mts`). Its active-state feedback comes from the bound
  action's catalog indicator (see below), so most keys need nothing more than
  `key('LABEL', '#colour', binding)` in the layout.
- A key that needs richer behaviour or stateful rendering is its own `Tile`
  class built on the injected services, one class per file. New dynamic keys
  (icons, per-state styling, animation) belong in their own class rather than
  in the shared renderer. The set today:

| Tile | What it is |
| --- | --- |
| `MediaTile` | Play/pause. Draws the play or pause glyph from the playback state, and the glyph breathes while playing. |
| `VoiceTile` | Start Assist, or cancel the pipeline already running. Expanding rings while one is live. |
| `BrightnessTile` | Steps the Stream Deck panel's own brightness through a few levels, showing the current percentage. Mutates display state on the model; the renderer re-lights the panel. |
| `ShuffleTile` | Shuffle on the media player, set from and reflecting what Home Assistant reports. |
| `PlaylistTile` | A one-press shortcut to a compiled-in playlist. |
| `SceneTile` | Steps through a short list of scenes, showing the one it last applied. |
| `EntityToggleTile` | The general Home Assistant on/off key — lights, fan, blinds, PC. Its service comes from the entity's own domain, and it takes an icon plus an optional `spin` (the fan turns while it runs) and `level` (how far the blinds are down), so the four are one class configured four ways. Given the dynamic dial it also hands that dial its entity when pressed. |
| `TimerTile` | A Home Assistant `timer` entity: a draining ring and a countdown, started and cancelled by the same key. |
| `TemperatureTile` | A sensor reading, with the background banded by temperature. Read-only. |
| `WeatherTile` | Condition glyph, short condition name, and the outside temperature. Read-only. |
| `ClockTile` | Local time with a bar that sweeps once a minute. Needs nothing but the clock. |
| `PageTile` | Page navigation from a grid slot, for a page that wants a "next" key of its own in addition to the page dial. |

A tile paints onto a `Surface` (`streamdeck/surface.mts`) the renderer owns: a
Skia canvas (`@napi-rs/canvas`) wrapped in the operations the control surface
repeats — a background wash, a line of text, an icon, a level bar. `surface.ctx`
is the real 2D context, so paths, clipping, transforms, gradients, and
compositing are available to any tile that wants them without a new helper.

Icons are Hugeicons SVGs. `tools/generate-icons.mjs` (run with `make icons`)
imports only the icons the layout names from the `@hugeicons/core-free-icons`
devDependency — a root development dependency, never the controller's — and
writes `streamdeck/icon-set.mts`, which is committed. So building, testing, and
deploying need no icon package, and the Pi never receives one; the full set is
5,448 icons and roughly thirty are drawn. `streamdeck/icons.mts` rasterizes one
at the size and tint a tile asks for and caches the result; the artwork strokes
in `currentColor`, so a key recolours its icon per state without touching the
path data. Add an icon by adding a line to the tool's `ICONS` map and running
`make icons`.

Text is drawn in Barlow Condensed, bundled at `apps/controller/assets/fonts/`
and registered explicitly at startup. Raspberry Pi OS Lite ships almost no
fonts, so falling back to a system face would draw blank labels on the Pi while
looking correct in the playground; bundling it also keeps the two identical.

The touch strip has the same arrangement one size up:
its faces are **screens** in `streamdeck/screens/`, described under [The touch
strip](#the-touch-strip).

A key that reads Home Assistant draws three states, not two: on, off, and *not
knowing*. An unreachable instance must never look like a fan that is simply
switched off, so unknown gets its own dim face.

Tiles have a lifecycle. `mount(host)` is called when a tile becomes visible on
an attached deck and `unmount()` when its page navigates away or the deck
disconnects. While mounted a tile may keep its own state, subscribe to the
`ControlModel` (`state.mts`) or watch Home Assistant entities to react to
changes, call `host.invalidate()` to repaint just its own key, and
`host.changePage(delta)` to navigate. Ordinary repaints are event-driven — any model
change schedules a full redraw, debounced at 50 ms — so an **animated** tile
runs its own timer between state changes: `VoiceTile` subscribes to the model,
starts a ripple timer while a voice pipeline is live, and accumulates the
`deltaTime` its `draw(surface, deltaTime)` is handed into its animation phase.
`draw` takes only the surface and that delta — a tile reads the live state it
paints from directly (the services it holds), never a passed-in context. Every
timer and subscription must be dropped in `unmount`.

## Voice actions — `type: lva`

Sent to the Linux Voice Assistant peripheral socket.

| Command | Effect |
| --- | --- |
| `start_listening` | Start a voice pipeline, the same as speaking the wake word. |
| `mute_toggle` | Toggle the microphone mute. Tracks the mute state reported by LVA. |
| `media_toggle` | Play or pause the media player. |
| `stop` | Stop everything at once: timer ringing, the pipeline, and media playback. |
| `listen_toggle` | Start a voice pipeline, or cancel the one already running. |
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

## Home Assistant — `type: ha`

Calls a Home Assistant service over the WebSocket API and reads entity state
back, which is what lets these keys show whether the fan is actually running.
Set `home_assistant_url` in inventory and `HOME_ASSISTANT_TOKEN` (a long-lived
access token) in the Pi's [secrets file](configuration.md#secrets); with neither
set every Home Assistant key stays on the deck and draws unknown state.

The service's domain comes from the entity id, so one `toggle` covers lights,
fans, covers, switches, and helpers — `fan.office_ceiling` is flipped by
`fan.toggle` and `cover.office_blinds` by `cover.toggle`, with no service named
in the layout.

| Command | Effect |
| --- | --- |
| `toggle` | Flip an entity on or off: a light, fan, switch, cover, or helper. |
| `turn_on` | Turn an entity on. A cover opens. |
| `turn_off` | Turn an entity off. A cover closes. |
| `activate` | Activate a scene or run a script, which have no matching "off". |
| `play_media` | Play a media id on a media player, such as a saved playlist. |
| `media_next` | Skip a media player to the next track. |
| `media_previous` | Send a media player back to the previous track. |
| `media_shuffle` | Toggle shuffle, from the shuffle state the player reports. |
| `brightness_up` | Raise a light's brightness by 10%. |
| `brightness_down` | Lower a light's brightness by 10%. |
| `fan_speed_up` | Raise a fan's speed by one of its own steps. |
| `fan_speed_down` | Lower a fan's speed by one of its own steps. |
| `cover_open` | Open a cover by 10%, or fully when it reports no position. |
| `cover_close` | Close a cover by 10%, or fully when it reports no position. |
| `timer_toggle` | Start a Home Assistant timer, or cancel the one already running. |

```ts
key('FAN', '#00695c', ha('toggle', 'fan.office_ceiling'))
```

A mistyped command is a compile error and a mistyped entity id fails `make test`,
either from `describeActionProblem` or — for a tile holding several entities,
such as the scene cycle — from the tile's own constructor.

Entity ids are compiled into `layout.mts` alongside the keys that use them,
gathered in the `HA` block at the top of the file. Which fan a key toggles is
part of what the key is; only the connection itself is inventory configuration.

## Nothing — `type: noop`

Does nothing. Use the `none()` binding to blank a dial direction you do not
want bound.

```ts
new ActionDial({ label: 'MONITOR', right: volume('up'), left: none(), readout: 'LEVEL' })
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
| `lva` / `listen_toggle` | Label becomes `CANCEL`, background cyan while the pipeline is running. |
| `audio` route (`on`/`off`/`toggle`) | Label gains ` ON` or ` OFF`, background green when on. |

The `MediaTile` used on the MAIN page goes further than the `media_toggle`
indicator: it draws a play or pause icon and colours itself from the playback
state. That state-driven rendering lives in the tile (see [Tiles](#tiles)), not
in the catalog.

## Dials

Each knob is a **`Dial`** — an interface in `streamdeck/dials/dial.mts`, with one
implementing class per file in `streamdeck/dials/`. A dial is the rotary
counterpart of a tile: it owns what turning and pressing it does *and* what it
reads out, so reordering the dials in `layout.mts` keeps every readout correct
and nothing has to work out what a knob means from what it happens to be bound
to.

Unlike a tile, a dial does not paint. The four share one face, drawn across the
whole strip by `DialScreen` while a knob is being turned; what a dial owns is
the content of that face:

- `detail(context)` is required and is the value line — `67%`, `PLAYING`,
  `NOT IN USE`. It has to read short and true even with nothing connected, since
  the strip shows it the instant a hand touches the knob.
- `level(context)` is optional: a 0–1 fraction drawn as a bar under the reading,
  for a value that really is a level. A bar is what makes a value readable while
  the knob is still moving. A dial with nothing to plot omits it.

| Dial | What it is |
| --- | --- |
| `ActionDial` | The default: a fixed name, up to three bindings, and a readout it is told. Also how a knob is held open — bound to nothing and saying so. |
| `VolumeDial` | Master output volume, read from the controller's own state so it is right with nothing else reachable. `MUTED` is its own reading, and an empty bar. |
| `MediaDial` | Transport: skip through the Music Assistant player, press to play or pause through LVA, and read `PLAYING` / `PAUSED`. |
| `EntityDial` | A Home Assistant entity turned by its own domain. Built by `EntityDial.for(...)`, which returns nothing for a domain with nothing to turn. |
| `PageDial` | Pages the key grid — turn to move between pages — and reads out the page you land on. Takes over the job the bottom-corner keys used to do. |
| `DynamicDial` | The shared knob, delegating to whichever `Dial` a key last handed it. |

Write a new `Dial` class when a knob needs a reading it has to work out for
itself; use `ActionDial` when it can be told.

The four dials as shipped:

| Dial | Turn left / right | Press |
| --- | --- | --- |
| `VOLUME` | Master volume down / up | Mute |
| `MEDIA` | Previous / next track | Play/pause |
| `PAGE` | Previous / next page of keys | — |
| *dynamic* | Whatever the last room key you pressed does | Toggle that entity |

Media transport goes through the Music Assistant player rather than LVA: the LVA
media player is the satellite's own announcement player and has no queue to skip
through. Play/pause stays on LVA, because that is where the controller's
playback state comes from.

### The dynamic dial

Three dials are fixed, because a knob you have to look at before turning is a
knob you stop using. The fourth is the opposite bargain: it has no job of its
own and controls whatever you last pressed, so one dial covers every dimmable,
variable-speed, part-open thing in the room without the deck growing a dial per
device.

Pressing `LIGHTS`, `FAN`, or `BLINDS` on the ROOM page does two things: it flips
the entity as it always did, and it hands that entity to the dial. The strip
shows the new readout straight away, so the thing you just pressed is also the
thing under your hand, and the key that holds the dial draws a cyan stripe along
its top edge — the same colour as the dial's own bar — so you can see which of
the three the knob will move without turning it to find out.

What turning it does comes from the entity's own domain, exactly as the toggle
service does (`EntityDial` in `streamdeck/dials/entity-dial.mts`):

| Domain | Turn left / right | Readout |
| --- | --- | --- |
| `light` | `brightness_down` / `brightness_up` | Brightness, or `ON` / `OFF` |
| `fan` | `fan_speed_down` / `fan_speed_up` | Speed, or `ON` / `OFF` |
| `cover` | `cover_close` / `cover_open` | How far open, or `OPEN` / `CLOSED` |

A domain that is absent from that table has nothing worth turning, so a key for
one — the desk PC switch — claims no dial when pressed and leaves the last claim
in place. Give a key the dial by passing `dial: dynamic` to its
`EntityToggleTile` in the layout; a new domain becomes turnable by adding a row
to `DIAL_DOMAINS`, which needs the stepping actions to exist in the catalog
first.

Before anything has been pressed the dial reads `CONTROL` / `PICK A KEY`, and an
unreachable Home Assistant reads `--` rather than a light turned all the way
down — the same rule the keys follow.

## The touch strip

The strip is one full-width display rather than four dial labels. Which of its
**screens** is showing is decided by `apps/controller/src/streamdeck/strip.mts`,
in this order:

| Showing | When | What it looks like |
| --- | --- | --- |
| Dial readout | For 2.5 s after a dial was last turned or pressed | The dial's name, its readout, and a bar for a dial with a level |
| Notification | While a message pushed from Home Assistant is live | Its heading and message on its own colour, with a draining time bar |
| Now playing | Otherwise | Track title, artist and album, and a position bar |

A hand on a knob wins over a live notification — feedback you cannot see while
turning is no feedback — and the notification comes back when the hold expires.

Each screen is a class in `streamdeck/screens/`, the strip's equivalent of a
tile: it paints the whole 800×100 face and may run the same `mount`/`unmount`
lifecycle, watching an entity and asking for animation frames. `NowPlayingScreen`
watches the media player entity itself, so the strip keeps working on pages where
no key happens to watch it. A title too wide for the strip is drawn smaller, and
scrolls once even the smallest size will not fit; a playing track repaints once a
second so its position bar creeps forward, since Music Assistant reports a
position once and then says nothing.

What is playing comes from the Music Assistant player entity — Home Assistant is
the only thing that knows a title — so a deployment with no token shows
`NO MEDIA INFO` rather than pretending the room is quiet.

## Notifications from Home Assistant

An automation puts a message on the strip by firing the `smartamp_notify` event.
This is the one thing the controller learns from Home Assistant that is not an
entity: "someone is at the door" and "the washing machine has finished" are
moments, not states, and a helper entity per message would be a helper per
message.

```yaml
# Home Assistant automation
triggers:
  - trigger: state
    entity_id: binary_sensor.front_doorbell
    to: 'on'
actions:
  - event: smartamp_notify
    event_data:
      title: FRONT DOOR
      message: SOMEONE IS AT THE DOOR
      color: '#b71c1c'   # optional, the banner colour
      seconds: 10        # optional, how long it stays up (default 8, max 120)
```

Only text is required, and either field will do: with just a `message` the banner
has no heading, and with just a `title` that line *is* the message. Messages
queue rather than overwrite, so a doorbell during the laundry banner still gets
its own time on the strip, and a message's clock starts when it reaches the strip
rather than when it arrived. Tapping the strip acknowledges the one showing and
lets the next through; anything fired while the controller is disconnected is
missed rather than delivered late, which is the right behaviour for a doorbell.

Nothing needs configuring on the Pi: the event name is compiled in
(`apps/controller/src/home-assistant/notifications.mts`) and the existing
Home Assistant connection carries it. To try one without a Pi, run
`make playground` and use the notification buttons in the Home Assistant panel.

## Sleeping when the room is empty

A lit deck in an empty office is the only thing that sleeps here. The wake word,
the ReSpeaker ring, Sendspin, and whatever is playing all keep running; the panel
simply switches off, and its keys stop drawing, animating, and watching entities
while nobody can see them.

It follows one Home Assistant presence sensor, named beside the other entity ids
in `layout.mts` and read over the connection the keys already use. Three things
keep the panel lit, and each restarts the grace period rather than pinning it
awake, so leaving the room always ends the same way:

| Keeps the panel lit | Why |
| --- | --- |
| The presence sensor reading `on` | Somebody is in the room |
| A live Assist pipeline — wake word, listening, thinking, speaking, a ringing timer | What Assist is doing has to be visible |
| A key press, dial turn, or tap on the strip | The safety net for a sensor that is simply wrong |

The panel goes dark two minutes after the last of those, and lights the instant
presence returns. **The first press on a dark deck only wakes it** — that press
is you asking to see the keys, not asking to toggle something you cannot read —
so nothing runs until you press again.

It fails towards a lit panel in every direction. An unreachable Home Assistant, a
sensor that has never reported, one reporting `unavailable`, an LED-only unit, and
a deployment with no `home_assistant_url` at all each mean the deck never sleeps:
a dark panel you cannot explain is worse than a lit one you did not need.

A notification pushed while the deck is asleep waits in the queue rather than
lighting an empty room, and is on the strip when you walk back in.

Both settings are compiled in, in `apps/controller/src/streamdeck/layout.mts`:

```ts
export const SLEEP = {
  presence: HA.presence,          // clear this to keep the deck lit permanently
  graceMilliseconds: 2 * 60_000,
} as const
```

The policy itself is `streamdeck/sleep.mts`, which writes one field —
`state.awake` — that the renderer follows exactly as it follows a deck being
unplugged. To watch it without a Pi, run `make playground` and use the
**leave room** and **enter room** buttons in the Home Assistant panel.

## Remote tiles from another computer

With `remote_tiles_enabled` set and a `REMOTE_TILES_TOKEN` in the Pi's secrets
file (see [configuration](configuration.md#remote-tiles)), the layout gains a REMOTE page
of six empty sockets and the controller listens on `remote_tiles_port` for
WebSocket clients on the LAN. A client — a Slack watcher on a desktop, a build
monitor, anything that can speak a few lines of JSON — pushes a face onto a
socket and gets the presses back; it never touches the deck itself, which stays
owned by the controller the same way it does for Home Assistant.

The whole protocol is five messages. The first thing on a new connection must
be the token, or the controller closes it:

```jsonc
// client -> controller
{ "type": "hello", "token": "<REMOTE_TILES_TOKEN>" }
{ "type": "tile", "slot": 0, "label": "SLACK", "color": "#4a154b",
  "image": "<base64 PNG>" }                    // set or replace a face
{ "type": "clear", "slot": 0 }
{ "type": "notify", "title": "SLACK", "message": "DM FROM SAM",
  "color": "#4a154b", "seconds": 8 }           // a touch-strip banner, exactly
                                               // as smartamp_notify above
// controller -> client
{ "type": "welcome", "slots": 6 }
{ "type": "press", "slot": 0 }
{ "type": "error", "message": "..." }          // the offending message was ignored
```

Slots are numbered 0–5 in reading order across the page. Everything but the
slot is optional on a `tile`: the image (any size; drawn to fill the 120x120
key, with the caption bar over its foot when a `label` is sent too) or just a
`color` and `label` like any other key. A face lives exactly as long as the
connection that pushed it — a client that disconnects or crashes takes its keys
with it, so the page can never show stale tiles.

`apps/remote-demo` is a runnable example client for the control computer:

```sh
pnpm --filter pimus-remote-demo start -- --token=<REMOTE_TILES_TOKEN>
```

It puts an unread-message badge on slot 0 that grows every few seconds,
clears when the key is pressed, and raises a strip banner in reply.

## Changing the layout

Edit `apps/controller/src/streamdeck/layout.mts`, then `make deploy-controller`.
The layout is built by `createLayout(services)` and its `pages` and `dials` are
ordinary TypeScript. Place a tile in a page slot with
`key('LABEL', '#colour', binding)`, or drop in a dynamic tile such as
`new MediaTile(services)`. Add a page by adding another `{ name, grid }` entry
to `pages`; each page's `grid` has the eight named slots (`topLeft`,
`topMidLeft`, `topMidRight`, `topRight`, `bottomLeft`, `bottomMidLeft`,
`bottomMidRight`, `bottomRight`), and its short `name` is what the page dial
reads out.

## Adding a new action

1. Add an entry to the relevant table in `apps/controller/src/actions/catalog.mts`.
2. For a voice or Home Assistant action, declare its `run` behaviour in the
   catalog entry itself. The compiler requires this — a catalogued action with
   no behaviour fails the build.
3. Document it in the table above; a test fails if it is missing here.
4. Bind it in `apps/controller/src/streamdeck/layout.mts`.
5. Run `make test`.
