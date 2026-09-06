# USB audio client

`apps/usb-audio` is an independent input app, alongside Sendspin. The audio
manager maintains the shared music bus, output gain, ducking, microphone and
idle policy. It has no gadget polling, ALSA host-volume agreement, USB route
configuration or USB status fields.

The USB app owns card activation, enumeration and Capture Rate detection,
volume/mute synchronisation, playback, input trim and the USB enable toggle.
The existing root `smartamp-usb-audio-gadget` service creates the UAC2 peripheral;
`smartamp-usb-audio` runs as the normal audio user and uses `pw-loopback` from the
already-installed `pipewire-bin` package.

## Playback and recovery

An enumerated host does not imply a running capture clock. The app listens to
`alsactl monitor`, subscribes to PipeWire graph changes and reconciles at least
every two seconds as a fallback. It starts playback only while the host is
streaming and the USB toggle is enabled. A stopped stream releases the client
before further graph queries, avoiding the existing dead-clock failure.

The music bus must have been published in a fresh manager status file before
USB starts. An intentionally idle bus is accepted: the external playback stream
wakes the manager through ordinary graph activity. Disabling USB stops its
client and permits idle teardown even if the computer continues streaming.

`pw-loopback` creates its playback node with `node.param.Props` setting mute and
zero channel volumes. The app waits for the stream, applies its trim through
`pactl`, then unmutes. A delayed stream or failed initial trim stays silent.
PipeWire documents [initial node parameters](https://docs.pipewire.org/page_man_pipewire-props_7.html);
this path was also checked against the 0.3.65 adapter implementation and exercised
with real PipeWire in a Debian Bookworm container.

The playback node carries `smartamp.volume.owner=client`. The manager honours
that property on playback buses, leaving the USB trim to its owner. It still
enforces music gain on direct hardware clients. The shared music bridge applies
room volume and ducking once, while the voice bus retains its separate gain.

Both endpoints forbid fallback, movement and reconnection to a different
source or sink. Restored stream properties are disabled. Each playback process
gets a fresh node identity, so a previous stream cannot be mistaken for the new
one. Device replacement or helper exit recreates the client. Stopping the app
reaps its children; systemd's `KillMode=control-group` also removes them after a
crash. No USB loopback is left in the PulseAudio server. During an upgrade, the
app removes a legacy loopback only when it has the old manager's exact USB
ownership tag.

## Volume and controls

The USB host mixer synchronises with the music sink's public volume/mute
register, the same interface Sendspin uses. The audio manager remains the owner
of the actual shared gain and hardware rebuild mute. On initial attachment,
gadget reappearance or bus recreation, the room seeds the host controls. Changes
then flow in both directions; when both sides changed, the bus wins. Remembering
read-back values prevents quantisation from causing feedback. Partial writes of
volume/mute are retried together.

A client that starts and then exits before its stream ever reaches the graph is
a fault that repeats, so each such death doubles the wait before the next spawn,
up to five seconds; a client that did play and then died is an ordinary restart
and is replaced at once. Reaching the graph clears the count, so the next fault
starts its own, and so does a new target — what went wrong for the old one says
nothing about this one.

The controller connects independently to:

- `smartamp-audio.sock`: music/voice levels, local routes, ducking and standby.
- `smartamp-usb-audio.sock`: USB toggle, trim and host/playback status.

`audio/system.mts` combines these states for the existing UI. Reconnection replays
each service's own cached controls. Losing the USB socket clears its playback
indicator while the manager remains usable, and turns the strip's audio icon
red: that icon stands for every audio service a unit runs, so a stopped input
service is visible rather than silent. The playground models both sockets.

The USB socket uses newline-delimited JSON. Commands are `get-state`,
`set-source-state` with `name: "usb"` and `state: "on" | "off" | "toggle"`, and
`set-source-trim` with `name: "usb"` and a numeric `percent` from 0 to 100.
State events contain `sources`, `usb_host`, `usb_playback` and `playing`.
`sources.usb` is the one USB source in the shape the audio manager lists its
own — its `trim`, its `enabled` toggle, whether the gadget's capture node is
`available`, and which `node` it is — so the controller merges the two lists
without knowing which service a source came from. `usb_playback` describes
host streaming; `playing` describes the app's configured playback stream.

## Deployment and validation

Existing inventory flags and trim defaults are preserved. Ansible renders
`usb-audio.json`, installs the shared `smartamp_audio` primitives and each app's
exact package tree, and manages the new service. Disabling the gadget flag also
stops and removes the USB runtime, configuration, socket and status file.
The doctor reads `smartamp-usb-audio-status.json` and checks both USB services.

`make test` runs both Python suites and strict type checks, controller tests and
bundle checks, ShellCheck, and Ansible syntax validation. `make playground-check`
checks the separate service fakes. Regression coverage includes stream gating,
muted startup and failed trim, target replacement, child cleanup, volume/mute
agreement and write recovery, stale legacy bridges, socket replay, independent
controller reconnects, bus trim ownership and normal idle activity detection.

`PYTHONPATH=libs/audio-common/src:apps/usb-audio/src python3 apps/usb-audio/test/check_pipewire.py`
runs against a test PipeWire/WirePlumber session and verifies native muted creation, trim-before-unmute
ordering, ownership properties and stream removal using synthetic endpoints.
Physical USB enumeration, unplug/suspend behaviour, playback latency, pops and
AEC still require validation on a Pi. These changes have not been provisioned.
