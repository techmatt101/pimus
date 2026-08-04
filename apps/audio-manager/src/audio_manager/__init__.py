"""Smart Amp audio manager: PipeWire defaults, routes, and voice ducking.

Five modules shape the graph, one audio path each. Three carry sound to the
amplifier:

    routes      aux and the USB gadget, bridged in as switchable inputs
    buses       the background and voice null sinks, each bridged in
    output      where all of that lands: the pinned HiFiBerry sink

and two serve the ReSpeaker's DSP instead, in `xvf3800`:

    microphone  its ASR channel, published as the source the assistant records
    aec         the output's monitor, sent back to it as the echo reference

Each owns both its endpoint and the link into it, because the gain held on
that link is state belonging to the pair. `graph` is the cached read of what
is really there, `modules` owns every PipeWire module loaded to build the
above, and `volume` is the shared level arithmetic.

`daemon` drives them in one reconcile order and nothing else, and `idle`
decides when the links may be released. Everything crossing a boundary is in a
folder: `control` is the socket the Node controller drives this daemon through,
`usb` what is kept agreed with a plugged-in computer, and `system` the only
place an external binary is run. `status` publishes a pass outward as a file,
for the doctor script and the voice assistant's start-up wait.
"""
