"""Native loopback smoke check using synthetic endpoints in a test PipeWire session.

Run with PYTHONPATH=libs/audio-common/src:apps/audio-inputs/src. This is
separate from unittest discovery because it requires running PipeWire and
WirePlumber.
"""
from __future__ import annotations

import os
import time
from smartamp_audio import graph, pactl
from audio_inputs.loopback import SOURCE_PROPERTY, Loopback


def main() -> None:
    prefix = f"pimus_test_{os.getpid()}"
    modules: list[int] = []
    view = graph.Graph()
    loopback = Loopback("usb", view, 40)

    try:
        for name in (f"{prefix}_source", f"{prefix}_music"):
            modules.append(pactl.load_module("module-null-sink", f"sink_name={name}"))
        source = view.source_named(f"{prefix}_source.monitor")
        sink = view.sink_named(f"{prefix}_music")
        assert source is not None and sink is not None
        for _ in range(100):
            view.invalidate()
            loopback.reconcile(source, sink)
            if loopback.ready:
                break
            time.sleep(0.05)
        assert loopback.ready, "Native input loopback never appeared"
        stream = next(s for s in pactl.list_json("sink-inputs")
                      if str(s.get("sink")) == str(sink["index"]))
        assert graph.volume_is(stream, 0), "The loopback was audible before the manager held it"
        assert stream.get("mute") is False, "The loopback was born muted; the manager never unmutes"
        assert graph.properties_of(stream).get(SOURCE_PROPERTY) == "usb"
        print("PASS: native loopback started silent, unmuted, and tagged with its source")
        loopback.stop()
        streams: list[graph.Node] = []
        for _ in range(100):
            streams = [s for s in pactl.list_json("sink-inputs")
                       if str(s.get("sink")) == str(sink["index"])]
            if not streams:
                break
            time.sleep(0.05)
        assert not streams, "The loopback survived child shutdown"
        print("PASS: child shutdown removed its playback stream")
    finally:
        loopback.stop()
        for module in reversed(modules):
            pactl.unload_module(module)


if __name__ == "__main__":
    main()
