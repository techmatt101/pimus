"""The local inputs: whatever needs a device to get onto the music bus.

The audio manager is a mixer and knows no card, gadget, or capture node. This
daemon runs one `Input` per configured entry (`inputs/`): the aux capture, the
USB gadget with its host gate and volume agreement, and any kind added later.
Each input runs a `pw-loopback` from its device into the music bus, born at
volume zero and tagged `smartamp.source=<name>`, which is all the manager needs
to hold it at that source's trim and toggle. Nothing here owns a trim, a
toggle, or a control socket; the status file is for the doctor.
"""
