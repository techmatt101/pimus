"""A process-owned loopback, born muted and connected only to explicit targets."""
from __future__ import annotations

import json
import os
import subprocess
from smartamp_audio import graph, pactl
from smartamp_audio.graph import Graph, Node

PLAYBACK_NODE = "smartamp_usb_playback"

# How soon to look again while the client is starting: its stream takes a
# moment to reach the graph, and every pass until then is an ordinary wait.
SETTLE_SECONDS = 0.1
# A client that exits without ever publishing a stream is a fault that repeats,
# so back off rather than respawning ten times a second into the journal. One
# that did publish and then died is an ordinary restart and retries at once.
MAX_RETRY_SECONDS = 5.0


class Playback:
    def __init__(self, view: Graph, latency_ms: int) -> None:
        self._graph = view
        self._latency_ms = latency_ms
        self._process: subprocess.Popen[bytes] | None = None
        self._binding: tuple[object, ...] | None = None
        self.ready = False
        self._generation = 0
        self._node_name = ""
        self._published = False
        self._failures = 0

    @property
    def retry_seconds(self) -> float:
        """How long to wait before looking again while not ready."""
        return min(MAX_RETRY_SECONDS, SETTLE_SECONDS * 2**self._failures)

    def stop(self) -> None:
        self.ready = False
        self._published = False
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
        moved = self._binding != binding
        died = self._process is not None and self._process.poll() is not None
        if moved or died or self._process is None:
            # A generation that never reached the graph failed; count it so the
            # retry widens. A new target starts the count again, because what
            # went wrong for the old one says nothing about this one.
            if died and not self._published:
                self._failures += 1
            if moved:
                self._failures = 0
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
        # The stream reached the graph, so whatever went wrong before did not
        # repeat: the next fault starts its own count.
        self._published = True
        self._failures = 0
        if not graph.volume_is(stream, trim):
            pactl.set_sink_input_volume(int(stream["index"]), trim)
        state = graph.volume_state(stream)
        if state is None or state[1]:
            pactl.set_sink_input_mute(int(stream["index"]), False)
        self.ready = True
