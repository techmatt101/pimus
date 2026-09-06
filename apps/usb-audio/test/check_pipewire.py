"""Native playback smoke check using synthetic endpoints in a test PipeWire session.

Run with PYTHONPATH=apps/audio-common/src:apps/usb-audio/src. This is separate
from unittest discovery because it requires running PipeWire and WirePlumber.
"""
from __future__ import annotations

import os
import time
from smartamp_audio import graph, pactl
from usb_audio.playback import Playback


def main() -> None:
    prefix = f"pimus_test_{os.getpid()}"
    modules: list[int] = []
    view = graph.Graph()
    playback = Playback(view, 40)
    real_volume = pactl.set_sink_input_volume
    real_mute = pactl.set_sink_input_mute
    writes: list[tuple[str, int | bool]] = []

    def set_volume(index: int, percent: int) -> None:
        stream = next(s for s in pactl.list_json("sink-inputs") if s["index"] == index)
        assert stream["mute"] is True, "Playback was audible before its initial trim"
        writes.append(("volume", percent))
        real_volume(index, percent)

    def set_mute(index: int, muted: bool) -> None:
        stream = next(s for s in pactl.list_json("sink-inputs") if s["index"] == index)
        assert graph.volume_is(stream, 25), "Playback unmuted before its trim landed"
        assert graph.properties_of(stream).get("smartamp.volume.owner") == "client"
        writes.append(("mute", muted))
        real_mute(index, muted)

    try:
        for name in (f"{prefix}_source", f"{prefix}_music"):
            modules.append(pactl.load_module("module-null-sink", f"sink_name={name}"))
        source = view.source_named(f"{prefix}_source.monitor")
        sink = view.sink_named(f"{prefix}_music")
        assert source is not None and sink is not None
        pactl.set_sink_input_volume = set_volume
        pactl.set_sink_input_mute = set_mute
        for _ in range(100):
            view.invalidate()
            playback.reconcile(source, sink, 25)
            if playback.ready:
                break
            time.sleep(0.05)
        assert playback.ready, "Native USB playback never appeared"
        assert writes == [("volume", 25), ("mute", False)], writes
        print("PASS: native playback started muted and applied its trim before unmuting")
        playback.stop()
        streams: list[graph.Node] = []
        for _ in range(100):
            streams = [s for s in pactl.list_json("sink-inputs")
                       if str(s.get("sink")) == str(sink["index"])]
            if not streams:
                break
            time.sleep(0.05)
        assert not streams, "Playback survived child shutdown"
        print("PASS: child shutdown removed its playback stream")
    finally:
        pactl.set_sink_input_volume = real_volume
        pactl.set_sink_input_mute = real_mute
        playback.stop()
        for module in reversed(modules):
            pactl.unload_module(module)


if __name__ == "__main__":
    main()
