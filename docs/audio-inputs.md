# Audio inputs

`apps/audio-inputs` is the app that brings a unit's local inputs onto the
music bus: the computer on the USB-C gadget port, and the analogue aux line-in
on a board with an ADC. It sits beside Sendspin as one more thing that plays
into the bus, and it knows as little about levels as Sendspin does. Every trim
and every on/off toggle is the audio manager's, which is a mixer: it holds a
configured list of source names, finds each source's streams on the bus, and
holds their gain. The inputs app only makes streams and tags them.

Neither daemon knows about the other's job. The manager never opens a card,
polls a gadget, or reads an ALSA control; the inputs app never sets a level.
Adding a source is therefore one class here and one name in inventory, or, for
a player that is a program of its own, no code at all — see
[adding a source](#adding-a-source).

## How a stream finds its source

A stream on the music bus belongs to the source named by its `smartamp.source`
property. The inputs app sets that property on every `pw-loopback` playback
node it creates, so an aux stream is tagged `aux` and a USB stream `usb`. A
stream with no tag belongs to `default_source` in `audio.json`, which inventory
names `sendspin`: it is what Sendspin's ALSA-pulse stream is, and what anything
that plays to the default sink is. The manager publishes each configured
source as `{trim, enabled?, available}`, where `available` means at least one
stream carrying that name is on the bus, and `enabled` is present only for the
switchable sources (aux, USB). See [architecture](architecture.md#audio-ownership).

Every stream the inputs app makes is born at volume zero. The manager snaps a
newly seen stream to its source's trim (or holds it at zero while the source
is off), so an input never plays a syllable at full level before its gain
lands. A toggle is a fade on the manager's side; the stream itself is untouched.

## Configuration

Ansible renders `/etc/smartamp/audio-inputs.json` with only the inputs the
unit has: `usb` when `usb_audio_gadget_enabled` is on, `aux` when the
HiFiBerry board has an ADC. Each input names its `kind` and the device
`match` it is found on, and the app is deployed only when at least one is
listed, so an Amp100 with no gadget gets no inputs unit at all.

```json
{
  "sink_name": "smartamp_music",
  "audio_status": "/run/user/999/smartamp-audio-status.json",
  "latency_ms": 20,
  "inputs": {
    "usb": {"kind": "usb_gadget", "match": "UAC2Gadget"},
    "aux": {"kind": "capture", "match": "HiFiBerry|snd_rpi_hifiberry|soc_sound", "latency_ms": 20}
  }
}
```

The app waits for the manager to publish the music bus in a fresh status file
before it plays anything, and reads that same file to learn when the graph is
idle. It publishes its own status to `smartamp-audio-inputs-status.json`:

```json
{
  "inputs": {
    "usb": {"host": true, "streaming": true, "node": "alsa_input.platform-fe980000.usb.stereo-fallback", "playing": true},
    "aux": {"node": "alsa_input.platform-soc_sound.stereo-fallback", "playing": true}
  }
}
```

`node` is the capture node the input was found on and `playing` whether its
loopback stream has reached the graph. The doctor reads this file; the
controller does not, because the deck's USB icon and the route keys read the
manager's source list instead.

## The USB gadget input

The root `smartamp-usb-audio-gadget` service creates the UAC2 peripheral at
boot; `smartamp-audio-inputs` runs as the normal audio user and uses
`pw-loopback` from the already-installed `pipewire-bin` package.

An enumerated host does not imply a running capture clock. The gadget's
capture only ticks while the computer holds its playback stream open, and a
loopback left connected to a dead clock stalls every other stream on the
driver. So the USB input runs its loopback only while the gadget card's
read-only `Capture Rate` control reads a non-zero rate, and stops it before
any further graph query once the rate reads zero. Enumeration
(`/sys/class/udc/*/state` reading `configured`) cannot gate this: with the
recommended VBUS-blocking adapter the port never reports a disconnect, so the
file stays `configured` after an unplug. It is reported in the status file
for what it is worth and gates nothing. The app listens to `alsactl monitor`
for the rate control, subscribes to PipeWire graph changes, and reconciles at
least every two seconds as a fallback. It holds no stream level, so a stream's
volume moving — every detent of the volume or trim dial — is not an event it
reconciles on; and a write of its own, to the gadget mixer or the bus
register, comes back through those feeds as an echo it recognises for a
quarter of a second rather than reacts to.

The loopbacks the app spawns carry the audio on data threads of their own,
which need `SCHED_FIFO` exactly as PipeWire's does. The unit grants it
(`LimitRTPRIO`, `LimitNICE`, `DISABLE_RTKIT=1`, as the service-account session
does for PipeWire); a loopback data-loop reading `TS` in `ps` is the fault
behind an amp that snaps every minute or so on the USB input.

The gadget's card boots parked on no profile, with no capture node; the input
switches it to `pro-audio` itself and lets the resulting graph event schedule
the pass that finds the node.

A loopback that starts and exits before its stream ever reaches the graph is a
fault that repeats, so each such death doubles the wait before the next spawn,
up to five seconds; one that did play and then died is an ordinary restart and
is replaced at once. Reaching the graph clears the count. Both endpoints forbid
fallback, movement and reconnection to a different source or sink, restored
stream properties are disabled, and each process gets a fresh node identity so
a previous stream cannot be mistaken for the new one. Stopping the app reaps
its children; systemd's `KillMode=control-group` removes them after a crash.
No USB loopback is ever a server module.

Because the USB source's toggle is the manager's, switching USB off does not
stop the stream: it plays into the bus at zero, and the manager does not count
a switched-off source's streams as activity, so the bridges can still release
into idle while the computer keeps streaming. The strip's cyan USB icon reads
`sources.usb.available` from the manager, which is exactly "a computer is
streaming to the gadget", on or off.

### Volume agreement

The gadget advertises a UAC2 mute/volume control, and the computer's writes to
it land on the gadget card's `PCM Capture` ALSA controls. The USB input keeps
those and the music bus sink's public volume/mute register converged in both
directions, the same register Sendspin follows with `--hardware-volume`: change
the volume on the computer and the amp follows, turn the dial and the
computer's slider follows, and the computer's mute key is the amp's volume
mute. On first attachment, gadget reappearance or bus recreation, the room
seeds the host controls. Whichever side moved since they last agreed wins;
when both changed, the bus wins so a dial or Sendspin command is not pulled
back by a stale host reading. Read-back values are remembered so the gadget's
volume quantisation is not mistaken for a new command, and a partial write of
volume and mute is retried together.

## The aux input

The aux input is the board's ADC, found by `smartamp_aux_match`. It runs its
loopback whenever the manager's status says the graph is awake, and stops it
while the graph is idle so the DC-carrying capture does not hold the HiFiBerry
path clocked through an empty evening. It is otherwise never switched:
connecting an analogue capture on demand lands any DC offset on the line as a
step on the speakers at full amplifier gain, so the connect happens once, at
zero, and the manager's toggle fades the stream between silent and its trim.
The manager marks activity when a switchable source is turned on, so an aux
toggle on a sleeping amp wakes the graph, the inputs app sees it awake and
rebuilds the loopback, and the manager fades the new stream up.

## Adding a source

A source is a name the manager mixes and something that plays into the bus
under that name.

- **A new local input** (a Chromecast receiver the Pi runs itself, a second
  capture) is a subclass of `Input` (`audio_inputs/inputs/input.py`): given
  the bus sink and whether the manager is keeping the graph awake, its
  `reconcile` decides whether its loopback should be running, and its
  `status` says what the doctor should see. Register it in `KINDS` in
  `audio_inputs/inputs/__init__.py`, add its block to `audio-inputs.json.j2`
  behind the inventory flag that says the unit has it, and add the source's
  name and trim to `audio.json.j2` with an `enabled` key if it should have a
  toggle. The deck's LEVELS and ROUTE keys pick the new name up from the
  manager's list.
- **A player that is a program of its own** needs nothing in this app. Point
  its unit at the music bus, as Sendspin's does with `PULSE_SINK`, and give
  the name a trim in `audio.json.j2`. Sendspin is the `default_source`: its
  streams carry no tag and land there, so a second such player must tag its
  own streams to be mixed apart from it — `Environment=PIPEWIRE_PROPS=` with
  `smartamp.source=<name>` for a native PipeWire client; for a PulseAudio
  client check on a live amp that a `PULSE_PROP` tag reaches the stream, which
  has not been verified. A player whose tag never lands plays under the
  default source's trim rather than not at all.

## Deployment and validation

Ansible renders `audio-inputs.json`, installs the shared `smartamp_audio`
primitives and the app's exact package tree, and manages the service, which is
`PartOf` the audio manager and restarts with it. A unit with neither input
gets none of that. The doctor checks the inputs
status file for each configured input's capture node under "Audio inputs",
and the service under "Services".

`make test` runs the app's unit tests and strict pyright beside the manager's.
The tests cover the USB stream gate, card activation, loopback creation at
zero with the source tag, target replacement, child cleanup and retry backoff,
volume/mute agreement and write recovery, and the aux input's idle gate.

Physical USB enumeration, unplug/suspend behaviour, playback latency, pops and
AEC still require validation on a Pi.
