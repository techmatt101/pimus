"""The named sinks the players play into, each bridged to the output at a gain.

The daemon does not know which application is playing. A player is an ordinary
PipeWire client that its own systemd unit points at one of these null sinks -
Sendspin through `PULSE_SINK`, the voice assistant through mpv's
`--audio-output-device` - and the daemon holds a whole class of playback at one
level on the sink's long-lived bridge into the output. Swapping a player for
another needs a change to its unit, not to anything here; adding a class of
playback with a level of its own is a new `PlaybackBus` subclass and a line in
the reconcile order.

    bus            `PlaybackBus`: the null sink, its bridge, and the gain held on it
    music          the music bus every music input plays into, dipped while the
                   assistant talks; the streams on it are the mixer's
                   (sources.py), each held at its source's trim
    music_level    the music level and its mute: the one number the music
                   bridge carries, dipped by the duck share, and every direct
                   client is held at
    music_volume   that bus's own sink volume, kept agreed with the music level
                   so a player can move the room and be told when something else
                   did
    voice          the assistant's bus, so speech has a level independent of music
    voice_meter    the voice bus's monitor reduced to one level per block, for
                   the ring to pulse to
"""
