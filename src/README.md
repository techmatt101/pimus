# Runtime source

This directory contains the code that runs on `office-amp`. It is deliberately
separate from `ansible/`, which is responsible only for deployment and system
configuration.

## Python services

- `audio_manager.py` maintains PipeWire defaults, aux/USB loopbacks, and the
  XVF3800 far-end reference route.
- `peripheral.py` converts Linux Voice Assistant events, Home Assistant light
  commands, and local LED state into XVF3800 USB control transfers.
- `smartampctl.py` is the non-privileged command interface used by the Stream
  Deck and by shell users for inputs, volume, and decorative LED modes.

## Stream Deck+

`streamdeck/index.mjs` renders the keys and touch strip, handles keys and rotary
encoders, and dispatches actions to Linux Voice Assistant, `smartampctl`, or an
optional Home Assistant webhook. `package-lock.json` pins the complete Node
dependency tree deployed by Ansible with `npm ci`. Deployment omits the optional
native JPEG peer and uses Elgato's built-in `jpeg-js` fallback, avoiding an
unnecessary native build toolchain on the Pi.
