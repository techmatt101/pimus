"""The relationship with a computer plugged into the USB audio gadget.

Only what has to be kept agreed with that host lives here: whether it is
enumerated and streaming (`host`), and the volume and mute the two sides
negotiate (`volume_sync`). The gadget's own ALSA commands stay in
`system/usb_gadget.py`, because every external binary is spawned from there,
and the route carrying its audio to the speakers is an ordinary entry in
`routes.py` handled exactly like the aux input.
"""
