# Stream Deck controls

Every action a Stream Deck key or dial can perform, and where to change the
bindings.

- **Bindings** live in `ansible/inventory/group_vars/all.yml` under
  `streamdeck_keys` and `streamdeck_dials`. This is the file you edit.
- **Behaviour** lives in `apps/controller/src/actions/catalog.mts`, which is the
  single source of truth for what an action does, how it is validated, and how a
  key lights up while its target is active.

After editing bindings, run `make provision` to regenerate `controller.json` on
the Pi. A mistyped action fails at controller startup with the key or dial named
in the error, rather than leaving a key that does nothing when pressed.

## Hardware

The Stream Deck+ has **8 keys** and **4 dials**. Each dial binds three separate
actions: `left` (counter-clockwise), `right` (clockwise), and `press`. Pressing
the LCD strip above a dial triggers that dial's `press` action.

Configuring more than 8 keys or 4 dials is rejected at startup.

## Voice actions — `type: lva`

Sent to the Linux Voice Assistant peripheral socket.

| Command | Effect |
| --- | --- |
| `start_listening` | Start a voice pipeline, the same as speaking the wake word. |
| `mute_toggle` | Toggle the microphone mute. Tracks the mute state reported by LVA. |
| `media_toggle` | Play or pause the media player. |
| `stop` | Stop everything at once: timer ringing, the pipeline, and media playback. |
| `stop_timer_ringing` | Silence a ringing timer, leaving media playback alone. |

```yaml
- { label: "VOICE", color: "#006064", action: { type: lva, command: start_listening } }
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

```yaml
- { label: "VOLUME", left: { type: audio, command: down }, right: { type: audio, command: up }, press: { type: audio, command: mute } }
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

```yaml
- { label: "AUX", color: "#4a148c", action: { type: audio, source: aux, command: toggle } }
```

YAML reads bare `on` and `off` as booleans, so quote them: `command: "on"`.

## Home Assistant webhooks — `type: webhook`

POSTs to `<home_assistant_webhook_base>/<id>`. Set the base URL in
`home_assistant_webhook_base`; with no base configured the action does nothing.
No Home Assistant token is stored on the Pi.

```yaml
- { label: "MOVIE", color: "#37474f", action: { type: webhook, id: movie_mode } }
```

## Nothing — `type: noop`

Does nothing. Use it to blank a dial direction you do not want bound.

```yaml
- { label: "VOICE", left: { type: noop }, right: { type: noop }, press: { type: lva, command: start_listening } }
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
assistant state. Reordering `streamdeck_dials` keeps each readout correct.

## Adding a new action

1. Add an entry to the relevant table in `apps/controller/src/actions/catalog.mts`.
2. For a voice action, add its runner in `apps/controller/src/actions/handler.mts`.
   The compiler requires this — a catalogued action with no runner fails the build.
3. Document it in the table above; a test fails if it is missing here.
4. Bind it in `ansible/inventory/group_vars/all.yml`.
5. Run `make test`.
