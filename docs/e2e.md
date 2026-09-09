# End-to-end hardware tests

`make e2e` checks that a real amp does everything it is configured to do. It
is on demand, never scheduled, and leaves every level where it found it. It
has two halves:

- **On the Pi**, `smartamp-selftest` (`tools/e2e/selftest`, deployed by
  Ansible because it must run there, kept under `tools/` because it is a test
  rather than an app of the amp's) drives every feature the unit has: the
  audio manager's socket vocabulary, the buses, idle teardown and the rebuild,
  the local inputs, the devices, and, audibly, the speaker and the microphone
  array. `make provision` installs it beside `smartamp-doctor`, which it
  does not replace: the doctor reports presence and state in a second, the
  self-test exercises behaviour over a couple of minutes.
- **On this computer**, `tools/e2e/src/e2e.mjs` runs that suite over SSH and then makes
  the checks only an outside party can: it plays into the USB-C sound card,
  fires a `smartamp_notify` event at Home Assistant, has the voice satellite
  announce, and streams a file to the Sendspin player, asking the Pi to watch
  for each.

The controller's display logic is not covered here: tiles, dials, screens and
ring faces are exercised in the [playground](playground.md). What the
controller does to hardware and to the daemons is: its socket connection, the
duck it sends for a reply, the notification an automation pushes, the deck
and array it opens, the USB ports it can cut.

## Running it

```sh
make e2e LIMIT=office-amp                       # one amp
make e2e                                        # every amp, in turn
make e2e LIMIT=office-amp E2E_ARGS="--silent"   # skip the audible tier
make e2e LIMIT=office-amp E2E_ARGS="--restart"  # also restart the daemons
make e2e LIMIT=office-amp E2E_ARGS="--reboot"   # also reboot and retest
```

Flags in `E2E_ARGS` are passed through to the Pi's suite except `--reboot`
and `--pi-only`, which are the tool's own:

| Flag | Does |
| --- | --- |
| `--silent` | Skip the audible tier. Everything else is near-silent: the ceiling is parked at its floor and the level kept low, so a tone reaches the amplifier some 80 dB down. |
| `--force` | Test even while something is playing. Otherwise a tier that would move levels skips itself when a client stream is live. |
| `--restart` | Include the recovery tier, which restarts the audio manager and the controller and watches everything find each other again. |
| `--only services,commands` / `--skip acoustic` | Choose tiers by name. |
| `--level 50` / `--min-rise-db 10` | The audible tier's music level and how far the array's output must rise. |
| `--reboot` | After everything else, reboot the Pi, wait for it, and rerun the silent tiers. |
| `--pi-only` | Run the Pi's suite and none of the checks from this computer. |

On the Pi itself the same suite is `sudo smartamp-selftest`, with the same
flags, and prints the report as text; `--json` prints it for a script. Each
`make e2e` run also writes its JSON report to `tools/e2e/reports/`, which git
ignores.

Every run exits non-zero if any check failed. A `WARN` does not fail the run;
a `SKIP` names the reason, most often a feature the unit does not have.

### What this computer needs

- SSH as the inventory's `ansible_user` with passwordless `sudo`, which is
  what `make provision` already uses.
- `HOME_ASSISTANT_TOKEN` in the environment for the Home Assistant, voice and
  player checks: a long-lived access token, the same kind the office amp's
  `secrets.env` holds. Without it those checks skip. `HOME_ASSISTANT_URL`
  overrides the inventory's URL.
- `sox` (`brew install sox`) and the amp's USB-C cable plugged into this
  computer for the USB check, which plays a tone into the sound card named
  `usb_audio_product`. Without either it skips.

## The tiers on the Pi

In the order they run:

| Tier | Checks | Audible |
| --- | --- | --- |
| `services` | Every configured unit is active; the status files are published with the sinks and sources inventory expects; since it started, the controller reached the voice assistant, Home Assistant and the deck, and has not logged a socket error in the last minute. | no |
| `hardware` | The HiFiBerry card and its ceiling control read; the array is on the USB bus and, on an XVF3800, answers `xvf_host` (`VERSION`, `AEC_AECCONVERGED`, `AUDIO_MGR_SYS_DELAY`, `AUDIO_MGR_REF_GAIN`); the capture sources are published and the assistant's is the default; the deck is on the bus; every USB port control the controller cuts in sleep is writable by the service account; the controller has logged no device trouble in ten minutes. | no |
| `commands` | The socket vocabulary: `get-state`; malformed and out-of-range commands are refused; every level command lands in the published state; the ceiling lands on the card; a switchable source toggles; a non-switchable one refuses; `resync` answers; a duck held by a second client is released when that client disconnects. | no |
| `playback` | A tone into the music bus is heard on the bus monitor at its own level, on the output monitor at the music level, moves by the predicted decibels for a level step, dips to the duck share under a duck lease, and vanishes under the mute. | no |
| `idle` | `force-idle` unloads the music bridge and the echo reference while leaving the null sink and the reference endpoints; a stream rebuilds them, and the rebuilt bridge fades in to the music level. | no |
| `voice` | A meter lease brings the voice bus up; a tone into it is reported by `voice_level` events and reaches the output at the voice level; the meter falls silent after. | no |
| `inputs` | On a unit with an aux input: switching it on puts its tagged stream on the bus at its trim, reported by both daemons; switching it off silences it. The USB input is reported, and driven by this computer's check. | no |
| `acoustic` | Broadband noise at a listening level: the ASR output the assistant records rises over the quiet room by at least the configured decibels, and the echo canceller reports converged. | **yes** |
| `recovery` | Only with `--restart`: the manager restarts and republishes; its dependants come back (they stop with it, and are started again if nothing did); the controller restarts and reconnects to everything. | no |

Every level the suite moves is snapshotted first and put back last: the music
and voice levels, the mute, the hardware ceiling, every trim and toggle, and
the duck and meter leases. A tier that raises is recorded as one failed check
and the run continues.

### What the levels mean

The manager's levels are PulseAudio percents, which PipeWire maps to a cubic
amplitude, so a step from 30% to 60% is predicted as +18 dB and checked to
within 3 dB. Levels are read as float samples off a monitor source, the
graph's own precision, so a ducked tone 80 dB down is still counted rather
than lost in a 16-bit floor. The first run on each unit is worth reading in
full: the tolerances were chosen from the mapping, not measured on a Pi.

### The audible tier

Noise rather than music, because music's self-similarity confounds both the
array's DSP and the measurement; five seconds at 40% by default. It fails only
when the array does not hear the speaker rise at least 6 dB over the quiet
room, which is what a dead amplifier, an unplugged speaker or a deaf array
look like. `AEC_AECCONVERGED` is read as supporting evidence and can only
warn: it latches, so a 1 records an earlier convergence, not this one. The
controller shares the array's control endpoint, so an implausible reading is
worth repeating, exactly as `docs/xvf3800.md` says of any tuning session.

## The checks from this computer

Each starts an observation on the Pi (`sudo smartamp-selftest observe usb`,
`player`, `voice`, `notify`), stimulates, then judges what the Pi saw. The
observations park the amp near-silent like the tiers do, and restore it after.

| Check | Stimulus | The Pi watches for |
| --- | --- | --- |
| `usb` | `sox` plays a 1 kHz tone at -20 dBFS into the CoreAudio device named `usb_audio_product` | the inputs app reporting a host attached and streaming, a stream tagged `smartamp.source=usb` on the music bus, and the tone on the output monitor |
| `home-assistant` | `POST /api/events/smartamp_notify` with a unique marker as the message | the controller's journal line for the event, which it logs with the message |
| `voice-satellite` | `assist_satellite.announce` on the satellite entity whose name is `voice_assistant_name` | a stream on the voice bus, a `voice_level` reading, and the music bus ducked |
| `sendspin` | `media_player.play_media` on the player entity whose name is `sendspin_name`, with a tone served over HTTP from this computer's LAN address | a live client stream on the music bus, the Sendspin source reported available, and sound on the output monitor; then `media_stop` |
| `reboot` | `systemctl reboot`, with `--reboot` | SSH back within four minutes, then the silent tiers pass again |

Home Assistant entity ids are not derivable from names, so the tool finds the
satellite and the player by their friendly names in `/api/states`; a name that
matches nothing or several things fails the check by saying so.

## What stays manual

- Speech quality, pops, and anything you would judge by ear.
- Ring colours and deck faces, which need eyes or a camera; the playground
  covers their logic.
- Waking the assistant acoustically. A recorded wake phrase played through the
  amp's own speaker is exactly what its echo canceller removes, so it is not a
  fair test; the announcement check proves the satellite path without the
  wake word, and `docs/xvf3800.md` records how the wake word was measured.
- Sleep and wake, which the deck's presence entity drives on a timer measured
  in minutes; the hardware tier confirms the port controls are writable and
  the recovery tier confirms the devices are reopened.
