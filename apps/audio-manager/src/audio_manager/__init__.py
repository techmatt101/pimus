"""Smart Amp audio manager: PipeWire defaults, routes, and voice ducking.

Four things shape the graph. Three carry sound to the amplifier:

    routes      aux and the USB gadget, bridged in as switchable inputs
    buses/      the named sinks the players play into - background music and
                the assistant's voice - each bridged in at its own gain
    output      where all of that lands: the pinned HiFiBerry sink

and one serves the assistant's hearing instead:

    microphone/ the capture device, the source published for the assistant to
                record, and the echo reference the device is sent

Each owns both its endpoint and the link into it, because the gain held on
that link is state belonging to the pair. Neither package names a product: a
player is whatever client its unit points at a bus, and a microphone is
assembled from the capture and echo-reference strategies its configuration
calls for. `graph` is the cached read of what is really there, `modules` owns
every PipeWire module loaded to build the above, and `volume` is the shared
level arithmetic.

`daemon` drives them in one reconcile order and nothing else, and `idle`
decides when the links may be released. Everything crossing a boundary is in a
folder: `control` is the socket the Node controller drives this daemon through,
`usb` what is kept agreed with a plugged-in computer, and `system` the only
place an external binary is run. `status` publishes a pass outward as a file,
for the doctor script and the voice assistant's start-up wait.
"""
