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

The Stream Deck controller is split by responsibility:

- `index.mjs` composes and starts the application.
- `config.mjs` loads and validates generated configuration.
- `state.mjs` owns the shared display/voice state model.
- `lva-client.mjs` handles the reconnecting LVA peripheral WebSocket.
- `actions.mjs` dispatches configured LVA, audio, LED, and webhook actions.
- `system-control.mjs` bridges to `smartampctl`, PipeWire, and route state.
- `bitmap.mjs` contains the dependency-free bitmap font and drawing primitives.
- `display.mjs` renders keys and the touch strip from current state.
- `deck-controller.mjs` owns device discovery, reconnects, and input events.

`package-lock.json` pins the Node dependency tree deployed by Ansible with
`npm ci`. Deployment omits the optional native JPEG peer and uses Elgato's
built-in `jpeg-js` fallback, avoiding an unnecessary native build toolchain.
