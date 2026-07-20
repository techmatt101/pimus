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

## Hardware

The Stream Deck+ has **8 keys** and **4 dials**. Each dial binds three separate
actions: `left` (counter-clockwise), `right` (clockwise), and `press`. Pressing
the LCD strip above a dial triggers that dial's `press` action. Fewer than 8
keys is fine; the unused slots render blank.

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
{ label: 'VOICE', color: '#006064', action: voice('start_listening') }
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
{ label: 'AUX', color: '#4a148c', action: route('aux', 'toggle') }
```

## Home Assistant webhooks — `type: webhook`

POSTs to `<home_assistant_webhook_base>/<id>`. Set the base URL in
`home_assistant_webhook_base`; with no base configured the action does nothing.
No Home Assistant token is stored on the Pi.

```ts
{ label: 'MOVIE', color: '#37474f', action: { type: 'webhook', id: 'movie_mode' } }
```

## Nothing — `type: noop`

Does nothing. Use the `NONE` action to blank a dial direction you do not want
bound.

```ts
{ label: 'VOICE', left: NONE, right: NONE, press: voice('start_listening') }
```

## Key and dial feedback

Some actions report their target's live state, so a key changes colour and label
without any extra configuration. Everything else keeps the label and colour you
configured.

| Bound action | While active |
| --- | --- |
| `lva` / `mute_toggle` | Label becomes `MIC OFF`, background red. |
| `lva` / `media_toggle` | Label becomes `PAUSE`, background green. |
| `lva` / `start_listening` | Background cyan while the pipeline is running. |
| `audio` route (`on`/`off`/`toggle`) | Label gains ` ON` or ` OFF`, background green when on. |

A dial's readout follows the actions bound to it rather than its position: a
dial with a master volume action shows the volume percentage or `MUTED`, a dial
with a route action shows `ON` or `OFF`, and anything else shows the voice
assistant state. Reordering the dials in `layout.mts` keeps each readout correct.

## Changing the layout

Edit `apps/controller/src/streamdeck/layout.mts`, then `make deploy-controller`.
The `KEYS` and `DIALS` arrays are ordinary TypeScript, so you can pull colours
into constants, build repeated bindings in a loop, or split a page of actions
into its own array.

## Adding a new action

1. Add an entry to the relevant table in `apps/controller/src/actions/catalog.mts`.
2. For a voice action, add its runner in `apps/controller/src/actions/handler.mts`.
   The compiler requires this — a catalogued action with no runner fails the build.
3. Document it in the table above; a test fails if it is missing here.
4. Bind it in `apps/controller/src/streamdeck/layout.mts`.
5. Run `make test`.
