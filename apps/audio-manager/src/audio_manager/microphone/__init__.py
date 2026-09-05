"""The microphone the assistant hears through, and what the daemon keeps ready on it.

Nothing here reaches the speakers. A microphone is three parts composed, and a
new device is a new choice for each part rather than a new package:

    device           finding the capture node by its match expression, and
                     repairing a card that came back from a USB power cycle
                     with no input profile
    capture          the source published for the assistant to record: one
                     channel lifted out of a multi-output DSP array
                     (`ChannelCapture`), or the device as it is
                     (`DirectCapture`)
    echo_reference   what the device is sent so it can subtract the room's own
                     playback from what it hears: the output's monitor looped
                     into its playback endpoint (`PlaybackEchoReference`), or
                     nothing (`NoEchoReference`)

`Microphone` reconciles the three in that order and answers with one status,
and `build` chooses the parts from the configuration. Both ReSpeaker arrays are
a `ChannelCapture` and a `PlaybackEchoReference` differing only in their
settings; a plain USB microphone would be a `DirectCapture` with
`NoEchoReference`, and a microphone with no cancellation of its own would bring
a new `Capture` that loads PipeWire's echo-cancel module instead.

The voice assistant's own playback is not here: TTS lands on the voice bus in
`buses/`. Neither is anything an array's LEDs do, which belongs to the Node
controller.
"""
