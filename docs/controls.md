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
[ 0 ][ 1 ][ 2 ][ 3 ]
[ 4 ][ 5 ][ 6 ][ 7 ]
```

A page is a 2×4 array laid out like the panel — the top row of four keys, then
the bottom — so you read where each tile sits directly. The page dial reads out
the name of the page you land on, and paging wraps around at either end. Because
the dials keep their bindings on every page, volume and transport are always one
turn away whichever page is showing — including the dial claimed on the ROOM
page, which stays claimed while you look at something else. Tiles keep the same
grid positions across pages — adding a page never reshuffles the keys already
placed. Any cell may be `null`; it renders blank.

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

| Tile               | What it is                                                                                                                                                                                                                                                                                                                                                     |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `MediaTile`        | Play/pause. Draws the play or pause glyph from the playback state, and the glyph breathes while playing.                                                                                                                                                                                                                                                       |
| `VoiceTile`        | Start Assist, or cancel the pipeline already running. The face follows the pipeline state with the same colours as the ReSpeaker ring: cyan expanding rings while listening, a purple orbiting spinner while thinking, a white pulse while speaking, a red pulse on a pipeline error, and a dimmed OFFLINE face while LVA is unreachable. A ringing timer belongs to `TimerTile`, not this key.                                                                                                                                                                                                                                                                       |
| `BrightnessTile`   | Adjusts the Stream Deck panel's own brightness. Press to arm, turn the dynamic dial to step it live in 5% notches — clamped at 0 and 100, never wrapping — press again to finish. Mutates display state on the model; the renderer re-lights the panel as the knob turns.                                                               |
| `VoiceVolumeTile`  | Adjusts the voice level — how loud Assist speaks, rings, and announces, independent of the music level. Press to arm, turn the dynamic dial to step it live in 5% notches — clamped at 0 and 100, never wrapping — press again to finish. Shows the audio manager's reported level, `?` while the manager is unreachable. The volume dial adjusts the same level whenever Assist is speaking.                                |
| `PlaylistTile`     | Picks and plays one of a short list of playlists. Press to arm (the key glows and claims the dynamic dial), turn the dynamic dial to choose, press again — the key or the knob — to confirm. A single playlist is just press-then-confirm. The armed state releases itself after 15s, or when any other dial or key is touched — that first touch only cancels the arm and does nothing else.        |
| `SceneTile`        | Picks one of a short list of scenes. Press to arm, turn to choose, press again — key or knob — to apply. Scenes have no state to read back, so it stays dim until the first apply, then shows the one last applied.                                                                                                                                              |
| `EntityToggleTile` | The general Home Assistant on/off key — lights, fan, blinds, PC. Its service comes from the entity's own domain, plus an icon and an optional `spin` (the fan turns while it runs) and `level` (how far the blinds are down), so the four are one class configured four ways. Its caption reads its own state rather than repeating the key's name: the icon says which device it is, so the room keys drop the label and show just `ON`/`OFF`, `OPEN`/`CLOSED`, or a percentage when part-way (fan speed, light brightness, blind position); `?` when unreachable. Given the dynamic dial, the first press arms it — glow, strip readout, 15s timeout — turning adjusts the level live and a second press toggles, so a double-press turns it on; a plain switch like PC has nothing to adjust and just toggles at once. |
| `TimerTile`        | The amp's assistant timer, whichever way it was set: a draining ring and a countdown, named if the timer is. Idle, press to arm the dynamic dial and set the length — it starts fresh at five minutes and the detent scales (a second under ten, five under a minute, then fifteen, thirty, a minute past ten minutes) — press again to start. While it runs the key cancels it, resumes it if a voice command paused it, and silences it while it rings. |
| `TemperatureTile`  | A sensor reading, with the background banded by temperature. Read-only.                                                                                                                                                                                                                                                                                        |
| `PageTile`         | Page navigation from a grid slot, for a page that wants a "next" key of its own in addition to the page dial.                                                                                                                                                                                                                                                  |

The arm-then-confirm behaviour those keys share — playlist, scene, brightness,
voice volume, and the room keys — is one helper, `streamdeck/armed-control.mts`:
the key composes an `ArmedControl` over the dynamic dial and the `Dial` it lends
(a `SelectionDial` picker, a `LevelDial` clamped 5% stepper for brightness and
voice volume, a `DurationDial` for the timer, or the one `entityDial`
builds from the entity's domain),
which owns the transient claim, the confirm-on-second-press, and the release. The
key keeps only its own drawing — the glow and what it shows while armed.

While a claim is armed it behaves like a light modal: touching any other dial or
key first cancels the claim, and that touch does nothing else — the dispatcher
swallows it rather than turning the volume or toggling a different room. Only the
owning key (`holdsDial()`) and the dynamic dial itself pass through, so the second
press confirms and the knob keeps switching. The renderer and touch strip enforce
this at the point a press is dispatched.

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
starts an animation timer while a voice pipeline is live, and accumulates the
`deltaTime` its `draw(surface, deltaTime)` is handed into its animation phase.
`draw` takes only the surface and that delta — a tile reads the live state it
paints from directly (the services it holds), never a passed-in context. Every
timer and subscription must be dropped in `unmount`.

## Voice actions — `type: lva`

Sent to the Linux Voice Assistant peripheral socket.

| Command              | Effect                                                                                        |
|----------------------|-----------------------------------------------------------------------------------------------|
| `start_listening`    | Start a voice pipeline, the same as speaking the wake word.                                   |
| `mute_toggle`        | Toggle the microphone mute. Tracks the mute state reported by LVA.                            |
| `listen_toggle`      | Start a voice pipeline, or cancel the one already running.                                    |
| `stop_timer_ringing` | Silence a ringing timer, leaving media playback alone.                                        |

```ts
key('VOICE', '#006064', voice('start_listening'))
```

Any other command is forwarded to LVA unchanged, so upstream features work
without a controller change. Forwarded commands get no local state tracking and
no key feedback; add them to the catalog when they need either.

Cancelling is `stop_pipeline`, which the pinned upstream only honours once a
response is speaking; the launcher adapter described in
[architecture](architecture.md) is what makes it abort while the satellite is
still listening or thinking.

### Timers

There is one kind of timer here. "Set a timer for five minutes" and the TIMER key
produce the same assistant timer on the same device: say it and the key picks the
countdown up mid-air, press the key and it announces and rings on the amp exactly
as a spoken one does.

The reading comes from the voice socket, which reports a timer when it starts,
changes, or rings rather than ticking — so the key derives the rest against the
clock and repaints itself twice a second. Starting, cancelling, and resuming go
the other way, through Home Assistant's timer intents, because Home Assistant
owns the timer and the satellite only mirrors it. Silencing a ring is the
exception: that goes straight down the voice socket as `stop_timer_ringing`, so
the room falls quiet on the press rather than a round trip later.

Three details come from the launcher adapter rather than the pinned upstream:
whether the timer is running or paused, the instant a reading was taken (so a
countdown stays honest when the socket replays state to a reconnecting
controller), and a distinct `timer_cancelled` event — upstream reports a
cancelled timer as the same plain `idle` that ends any voice pipeline, which
would wipe a perfectly good countdown off the key every time you asked the
assistant something.

## Music volume — `type: audio` with no `source`

Drives the audio manager's music level — the gain every non-voice path (music,
USB computer audio, aux) plays at; the output sink itself stays pinned at 100%
and voice keeps its own level. `mute` is the exception: it toggles the sink
itself through the audio manager's `set-output-mute`, silencing music and voice
alike, and a mute made anywhere else shows on the deck. While a computer is on the
USB-C gadget port, the audio manager keeps the music level and the computer's
volume control for the device converged in both directions: the computer's
volume keys move the amp, and the dial moves the computer's slider.

| Command | Effect                                                     |
|---------|------------------------------------------------------------|
| `up`    | Raise the music level by 5%, capped at 100%.               |
| `down`  | Lower the music level by 5%.                               |
| `mute`  | Toggle mute on the output, silencing music and voice alike.|

```ts
{
    label: 'VOLUME', left
:
    volume('down'), right
:
    volume('up'), press
:
    volume('mute')
}
```

## Audio routes — `type: audio` with a `source`

Toggles a named route through the audio manager's control socket. `source` must
be a route the audio manager owns, currently `aux` or `usb`; it rejects names it
does not know. Aux toggles are a short fade of a permanently loaded bridge
rather than a stream connect, so they are pop-free; the USB route connects and
disconnects for real, and only while the computer is actively streaming audio
to the gadget port.

| Command  | Effect                                |
|----------|---------------------------------------|
| `on`     | Enable the named audio route.         |
| `off`    | Disable the named audio route.        |
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

| Command           | Effect                                                            |
|-------------------|-------------------------------------------------------------------|
| `toggle`          | Flip an entity on or off: a light, fan, switch, cover, or helper. |
| `turn_on`         | Turn an entity on. A cover opens.                                 |
| `turn_off`        | Turn an entity off. A cover closes.                               |
| `activate`        | Activate a scene or run a script, which have no matching "off".   |
| `play_media`      | Play a media id on a media player, such as a saved playlist.      |
| `media_play_pause`| Play or pause a media player, from the state it reports.          |
| `media_next`      | Skip a media player to the next track.                            |
| `media_previous`  | Send a media player back to the previous track.                   |
| `media_shuffle`   | Toggle shuffle, from the shuffle state the player reports.        |
| `media_repeat`    | Cycle repeat off, all, one, from the mode the player reports.     |
| `timer_start`     | Start an assistant timer on the satellite, as a spoken "set a timer" does. |
| `timer_cancel`    | Cancel the assistant timer running on the satellite.              |
| `timer_resume`    | Resume the assistant timer a voice command paused.                |

```ts
key('FAN', '#00695c', ha('toggle', 'fan.office_ceiling'))
```

The three timer commands are **intents**, not service calls: an assistant timer
belongs to a device rather than an entity, so it has no service and no entity to
aim at. They are posted to `/api/intent/handle` — the one part of Home Assistant
the controller reaches over REST instead of the WebSocket — naming the device
behind the entity you pass, which the client resolves once from the entity
registry and remembers. Pass the satellite (`assist_satellite.office_amp`), not a
`timer` helper.

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

| Bound action                        | While active                                                           |
|-------------------------------------|------------------------------------------------------------------------|
| `lva` / `mute_toggle`               | Label becomes `MIC OFF`, background red.                               |
| `lva` / `start_listening`           | Background cyan while the pipeline is running.                         |
| `lva` / `listen_toggle`             | Label becomes `CANCEL`, background cyan while the pipeline is running. |
| `audio` route (`on`/`off`/`toggle`) | Label gains ` ON` or ` OFF`, background green when on.                 |

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

| Dial          | What it is                                                                                                                                           |
|---------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ActionDial`  | The default: a fixed name, up to three bindings, and a readout it is told. Also how a knob is held open — bound to nothing and saying so.            |
| `VolumeDial`  | The music level, read from the audio manager's reported state (`?` while it is unreachable). `MUTED` is its own reading, and an empty bar. While Assist is live (wake through TTS, or a ringing timer) it relabels to `VOICE` and steers the voice level instead, so a shout can be turned down as it happens without touching the music. |
| `MediaDial`   | Transport through the Music Assistant player: skip with a turn, play or pause with a press, and read `PLAYING` / `PAUSED` from the player.           |
| `PageDial`    | Pages the key grid — turn to move between pages — and reads out the page you land on. Takes over the job the bottom-corner keys used to do.          |
| `DynamicDial` | The shared knob. A playlist key hands it a `Dial` to delegate to; a room key hands it the `Dial` its entity's domain builds (`entityDial`).           |

Write a new `Dial` class when a knob needs a reading it has to work out for
itself; use `ActionDial` when it can be told.

The four dials as shipped:

| Dial      | Turn left / right                           | Press              |
|-----------|---------------------------------------------|--------------------|
| `VOLUME`  | Music level down / up; the voice level while Assist is live | Mute               |
| `MEDIA`   | Previous / next track                       | Play/pause         |
| `PAGE`    | Previous / next page of keys                | —                  |
| *dynamic* | Whatever the last room key you pressed does | Toggle that entity |

All media transport — skip, shuffle, and play/pause alike — goes through the
Music Assistant player rather than LVA: the LVA media player is the satellite's
own announcement player, with no queue to skip through and no bearing on what
the speakers are playing.

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

What turning it does comes from the entity's own domain, which `DynamicDial`
derives itself (`streamdeck/dials/dynamic-dial.mts`) exactly as the toggle
service does:

| Domain  | Turn left / right         | Readout                            |
|---------|---------------------------|------------------------------------|
| `light` | Brightness down / up      | Brightness, or `ON` / `OFF`        |
| `fan`   | Speed down / up           | Speed, or `ON` / `OFF`             |
| `cover` | Close / open by position  | How far open, or `OPEN` / `CLOSED` |

Each detent nudges the cached level so the strip and key move under your hand at
once, but the device command is debounced (`EntityLevel` in
`streamdeck/dials/entity-level.mts`): a quick spin settles into a single absolute
set — `brightness_pct`, `set_percentage`, `set_cover_position` — rather than a
burst of steps, so a fast turn never floods the light, fan, or blind. The nudge
goes through `HomeAssistantService.patch`, which overwrites the cached state
until Home Assistant echoes the real one back.

A domain that is absent from that table has nothing worth turning, so a key for
one — the desk PC switch — claims no dial when pressed and leaves the last claim
in place. Give a key the dial by passing `dial: dynamic` to its
`EntityToggleTile` in the layout; a new domain becomes turnable by adding a row
to `DIAL_DOMAINS` with how to read, step, set, and optimistically cache its
level.

Before anything has been pressed the dial reads `CONTROL` / `PICK A KEY`, and an
unreachable Home Assistant reads `--` rather than a light turned all the way
down — the same rule the keys follow.

A room key's claim is **sticky**: it stays under the knob while you page away, so
you can adjust a light from any page until you claim something else. A
`PlaylistTile`'s claim is **transient** — a modal "pick one now" (the key glows,
`streamdeck/dials/selection-dial.mts`) — so it times out after 15 seconds of no
turning, is dropped the instant a different dial is touched, and releases as soon
as it is confirmed. The two are the same `claim(...)` call with one flag; a tile
that wants the same pick-then-confirm hands the shared dial a `SelectionDial` and
draws `drawActiveGlow` while it holds it.

## The touch strip

The strip is one full-width display rather than four dial labels. Which of its
**screens** is showing is decided by `apps/controller/src/streamdeck/strip.mts`,
in this order:

| Showing      | When                                               | What it looks like                                                  |
|--------------|----------------------------------------------------|---------------------------------------------------------------------|
| Dial readout | For 2.5 s after a dial was last turned or pressed, or the whole time a key is mid-pick on the shared dial | The dial's name, its readout, and a bar for a dial with a level     |
| Notification | While a message pushed from Home Assistant is live | Its heading and message on its own colour, with a draining time bar |
| Starting up  | During boot, until the network, audio manager, and Home Assistant have all connected (90 s at most) | "STARTING UP" over a row of the three subsystems: teal once connected, amber and breathing while still pending |
| Now playing  | A track is playing or paused                       | A play/pause button at the left edge, the track title and credit (scrolling only when too long, tap to reveal shuffle/repeat/back), a clock at the right edge, and a position bar |
| Idle clock   | The player is stopped (nothing playing)            | The time centred, with the current outdoor conditions beside it |

A hand on a knob wins over a live notification — feedback you cannot see while
turning is no feedback — and the notification comes back when the hold expires.

### Status icons

The idle clock carries a row of system-health icons at its left edge: network
(wifi), Home Assistant (home), the microphone (mic), and the audio manager
(volume). A cyan usb icon joins the row only while a computer is actively
streaming audio to the USB-C gadget port, and disappears when playback stops
or the cable is pulled. It cannot mean merely "plugged in": the VBUS-blocked
port never reports an unplug, so an idle connection and a missing one are
indistinguishable. Healthy icons sit dim. A failed subsystem turns its icon red
and pulses it, and the loss also posts a strip banner ("HOME ASSISTANT LOST");
recovery is silent, the icon simply stops flashing. A mute is red too but
steady, since it is deliberate rather than a failure: the mic and volume icons
are drawn crossed out while the microphone or the output is muted. The
now-playing face has no room for the full row and shows only the red icons,
tucked under the clock. A deployment without Home Assistant configured keeps
that icon healthy rather than flagging an integration that was never set up.

Each screen is a class in `streamdeck/screens/`, the strip's equivalent of a
tile: it paints the whole 800×100 face and may run the same `mount`/`unmount`
lifecycle, watching an entity and asking for animation frames. The resting face
is three screens rather than one — `StartingScreen` while the stack is still
coming up, `NowPlayingScreen` while a track is playing or paused, and
`IdleScreen` (the clock) once the player is stopped. The controller now starts
well before the audio manager and voice assistant are ready, so without the
first of those the panel's opening face would be a row of red fault icons,
which reads as broken rather than busy; it latches off for good once everything
has connected once, so a later outage is reported as the fault it is. The strip
is handed all three and shows the first whose `applies()` returns true; all stay mounted, so
the one not showing keeps watching its entity and swaps the strip over the moment
a track starts or stops. `NowPlayingScreen` watches the media player entity
itself, so the strip keeps working on pages where no key happens to watch it. Its
title and credit are left-aligned; a title too wide for the text region is drawn
smaller, and scrolls once even the smallest size will not fit; a playing track
repaints once a second so its position bar creeps forward, since Music Assistant
reports a position once and then says nothing.

The left edge of the now-playing face carries the play/pause button — the glyph
is lit while playing — and tapping it runs on the Music Assistant player, exactly
as the media dial does. Tapping the track title swaps it for a transient row of
transport extras: a back button on the left that just dismisses the row, then
shuffle and repeat (off, then all, then one — its glyph lit whenever it is not
off, with a `1` while it repeats one). Shuffle and repeat reflect and set their
state the same way; the row also fades back to the title a few idle seconds after
the last tap. The right edge carries a clock, so a glance at the strip always
tells the time; a tap on the clock falls through to the dial in that zone.

`IdleScreen` is the resting face when the player is stopped: the time centred,
with the current outdoor conditions beside it — read from the `weather.` entity
it is given — rather than a "nothing playing" placeholder. The clock needs
nothing but its own wall clock, so it still works with no Home Assistant
configured; the weather simply stays away then. It reads 24- or 12-hour from the
`clockFormat` the layout hands both strip faces — `12h` adding a small AM/PM
riding against the top of the time — so the two clocks always agree. Paused
counts as playing here —
it keeps its track, so the strip stays on the now-playing face — and only a
genuinely stopped player falls through to the clock. There is nothing to act on
then, so a tap anywhere falls through to the dial beneath.

A tapped button flashes — it lights and fades over about a fifth of a second —
so a press is acknowledged rather than only its result. This is as close to a
held "pressing" state as the strip allows: its LCD reports a tap only once the
finger lifts (there is no finger-down event for it), so the flash begins on
release rather than on touch.

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
simply dims and then switches off, and its keys stop drawing, animating, and
watching entities while nobody can see them.

It follows one Home Assistant presence sensor, named beside the other entity ids
in `layout.mts` and read over the connection the keys already use. Three things
keep the panel lit, and each restarts the grace period rather than pinning it
awake, so leaving the room always ends the same way:

| Keeps the panel lit                                                                | Why                                              |
|------------------------------------------------------------------------------------|--------------------------------------------------|
| The presence sensor reading `on`                                                   | Somebody is in the room                          |
| A live Assist pipeline — wake word, listening, thinking, speaking, a ringing timer | What Assist is doing has to be visible           |
| A key press, dial turn, or tap on the strip                                        | The safety net for a sensor that is simply wrong |

Two minutes after the last of those the panel dims, and five seconds later it
goes dark; either way it comes back to full brightness the instant presence
returns. The dim is the warning: a deck that is about to switch off in a room the
sensor has misjudged is still readable, and touching anything on it during those
five seconds both runs the key and restores the light. **The first press on a
dark deck only wakes it** — that press is you asking to see the keys, not asking
to toggle something you cannot read — so nothing runs until you press again.

It fails towards a lit panel in every direction. An unreachable Home Assistant, a
sensor that has never reported, one reporting `unavailable`, an LED-only unit, and
a deployment with no `home_assistant_url` at all each mean the deck never sleeps:
a dark panel you cannot explain is worse than a lit one you did not need.

A notification pushed while the deck is asleep waits in the queue rather than
lighting an empty room, and is on the strip when you walk back in.

All three settings are compiled in, in `apps/controller/src/streamdeck/layout.mts`:

```ts
export const SLEEP = {
  presence: HA.presence,          // clear this to keep the deck lit permanently
  graceMilliseconds: 2 * 60_000,
  dimMilliseconds: 5_000,         // how long it is dimmed before going dark
} as const
```

The policy itself is `streamdeck/sleep.mts`, which writes one field —
`state.panel`, one of `lit`, `dim`, and `off` — that the renderer follows exactly
as it follows a deck being unplugged. To watch it without a Pi, run
`make playground` and use the
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
ordinary TypeScript. Place a tile in a grid cell with
`key('LABEL', '#colour', binding)`, or drop in a dynamic tile such as
`new TimerTile(ha, clock, {…})` — each tile is handed only the domain services
it uses, not a bag of all of them. Add a page by adding another `{ name, grid }`
entry to `pages`; each page's `grid` is a 2×4 array (the top row of four keys,
then the bottom, with `null` for a blank cell), and its short `name` is what the
page dial reads out.

## Adding a new action

1. Add an entry to the relevant table in `apps/controller/src/actions/catalog.mts`.
2. For a voice or Home Assistant action, declare its `run` behaviour in the
   catalog entry itself. The compiler requires this — a catalogued action with
   no behaviour fails the build.
3. Document it in the table above; a test fails if it is missing here.
4. Bind it in `apps/controller/src/streamdeck/layout.mts`.
5. Run `make test`.
