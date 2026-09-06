"""A process-owned loopback, born muted and connected only to explicit targets."""
from __future__ import annotations

import json
import os
import subprocess
from smartamp_audio import graph, pactl
from smartamp_audio.graph import Graph, Node

PLAYBACK_NODE = "smartamp_usb_playback"


class Playback:
    def __init__(self, view: Graph, latency_ms: int) -> None:
        self._graph = view
        self._latency_ms = latency_ms
        self._process: subprocess.Popen[bytes] | None = None
        self._binding: tuple[object, ...] | None = None
        self.ready = False
        self._generation = 0
        self._node_name = ""

    def stop(self) -> None:
        self.ready = False
        running = self._process
        self._process = None
        self._binding = None
        if running is None:
            return
        if running.poll() is None:
            running.terminate()
            try:
                running.wait(timeout=1)
            except subprocess.TimeoutExpired:
                running.kill()
                running.wait(timeout=1)
        else:
            running.wait()

    def reconcile(self, source: Node, sink: Node, trim: int) -> None:
        binding = (source["name"], source.get("index"), sink["name"], sink.get("index"))
        if (self._binding != binding
                or self._process is None or self._process.poll() is not None):
            self.stop()
            self._generation += 1
            self._node_name = f"{PLAYBACK_NODE}_{os.getpid()}_{self._generation}"
            common = {
                "node.dont-fallback": True,
                "node.dont-reconnect": True,
                "node.dont-move": True,
                "state.restore-props": False,
                "node.stream.restore-props": False,
                "node.stream.restore-target": False,
            }
            capture = {**common, "node.name": "smartamp_usb_capture"}
            playback = {
                **common,
                "node.name": self._node_name,
                "media.name": "USB Audio",
                "smartamp.volume.owner": "client",
                # PipeWire's adapter applies these before exporting the node.
                # A delayed query or failed trim leaves this stream silent.
                "node.param.Props": {"mute": True, "channelVolumes": [0.0, 0.0]},
            }
            self._process = subprocess.Popen(
                ["pw-loopback", "--capture", str(source["name"]),
                 "--playback", str(sink["name"]), "--channels", "2",
                 "--latency", str(self._latency_ms),
                 "--capture-props", json.dumps(capture),
                 "--playback-props", json.dumps(playback)],
                stdout=subprocess.DEVNULL,
            )
            self._binding = binding
            self._graph.invalidate()
        self.ready = False
        stream = next(
            (entry for entry in self._graph.sink_inputs
             if graph.properties_of(entry).get("node.name") == self._node_name),
            None,
        )
        if stream is None:
            return
        if not graph.volume_is(stream, trim):
            pactl.set_sink_input_volume(int(stream["index"]), trim)
        state = graph.volume_state(stream)
        if state is None or state[1]:
            pactl.set_sink_input_mute(int(stream["index"]), False)
        self.ready = True
