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
every page, volume and transport are always one turn away whichever page is
showing — including the dial claimed on the ROOM page, which stays claimed while
you look at something else. A layout with a single page shows no nav keys, and its tiles keep the
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
  class built on the injected services, one class per file. New dynamic keys
  (icons, per-state styling, animation) belong in their own class rather than
  in the shared renderer. The set today:

| Tile | What it is |
| --- | --- |
| `MediaTile` | Play/pause. Draws a play triangle or pause bars from the playback state, and the bars breathe while playing. |
| `VoiceTile` | Start Assist, or cancel the pipeline already running. Expanding rings while one is live. |
| `AudioModeTile` | Cycles the input (stream / aux / usb), turning the chosen route on and the rest off. Reads the current mode back from the audio manager rather than remembering it. |
| `ShuffleTile` | Shuffle on the media player, set from and reflecting what Home Assistant reports. |
| `PlaylistTile` | A one-press shortcut to a compiled-in playlist. |
| `SceneTile` | Steps through a short list of scenes, showing the one it last applied. |
| `EntityToggleTile` | The general Home Assistant on/off key — lights, fan, blinds, PC. Its service comes from the entity's own domain, and it takes an icon and an optional animation phase, so the four are one class configured four ways. Given the dynamic dial it also hands that dial its entity when pressed. |
| `TimerTile` | A Home Assistant `timer` entity: a draining ring and a countdown, started and cancelled by the same key. |
| `TemperatureTile` | A sensor reading, with the background banded by temperature. Read-only. |
| `WeatherTile` | Condition glyph, short condition name, and the outside temperature. Read-only. |
| `ClockTile` | Local time with a bar that sweeps once a minute. Needs nothing but the clock. |
| `PageTile` | Page navigation in any grid slot, for a page that wants its "next" somewhere other than the reserved corner. |

Icons are drawn from the primitives in `streamdeck/bitmap.mts` and shared in
`streamdeck/icons.mts`, so the controller ships no binary assets and needs no
image decoder on the Pi. The touch strip has the same arrangement one size up:
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
Set `home_assistant_url` and `home_assistant_token` (a long-lived access token)
in inventory; with neither set every Home Assistant key stays on the deck and
draws unknown state.

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

## Home Assistant webhooks — `type: webhook`

POSTs to `<home_assistant_webhook_base>/<id>`. Set the base URL in
`home_assistant_webhook_base`; with no base configured the action does nothing.
This needs no token, so it stays useful for firing an automation on an instance
you would rather not hand the controller a token for — but it is write-only, and
a key bound to one can show no state.

```ts
key('MOVIE', '#37474f', webhook('movie_mode'))
```

## Nothing — `type: noop`

Does nothing. Use the `none()` binding to blank a dial direction you do not
want bound.

```ts
{ label: 'SPARE', left: none(), right: none(), press: none(), detail: () => 'NOT IN USE' }
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
The readout is shown across the whole strip while the dial is being turned, not
in a column of its own.

A dial reporting something the bound actions cannot express supplies its own
`detail(context)` — the dial equivalent of a tile drawing its own face. The
dynamic dial uses it to show brightness, speed, or how far open something is,
and the media dial to show `PLAYING` or `PAUSED`. A dial whose value really is a
level also supplies `level(context)`, a 0–1 fraction drawn as a bar under the
readout; master volume needs none, since the readout derives it from the bound
action.

The four dials as shipped:

| Dial | Turn left / right | Press |
| --- | --- | --- |
| `VOLUME` | Master volume down / up | Mute |
| `MEDIA` | Previous / next track | Play/pause |
| `SPARE` | — | — |
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
service does (`entityDial` in `streamdeck/dynamic-dial.mts`):

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
`home_assistant_token` connection carries it. To try one without a Pi, run
`make playground` and use the notification buttons in the Home Assistant panel.

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
2. For a voice or Home Assistant action, declare its `run` behaviour in the
   catalog entry itself. The compiler requires this — a catalogued action with
   no behaviour fails the build.
3. Document it in the table above; a test fails if it is missing here.
4. Bind it in `apps/controller/src/streamdeck/layout.mts`.
5. Run `make test`.
