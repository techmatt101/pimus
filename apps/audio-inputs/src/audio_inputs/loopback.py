"""A process-owned loopback into the bus, born silent and tagged with its source.

The loopback is a child client, never a server module: it dies with this
daemon, so a stopped or crashed daemon can never leave a device's clock linked
into the graph. Its playback stream is created at volume zero, so nothing is
heard until the audio manager holds it at the source's trim, and it carries
the `smartamp.source` tag that tells the manager whose stream it is.
"""

from __future__ import annotations

import json
import os
import subprocess

from smartamp_audio import graph
from smartamp_audio.graph import Graph, Node


SOURCE_PROPERTY = "smartamp.source"
PLAYBACK_NODE = "smartamp_input"

# How soon to look again while the client is starting: its stream takes a
# moment to reach the graph, and every pass until then is an ordinary wait.
SETTLE_SECONDS = 0.1
# A client that exits without ever publishing a stream is a fault that repeats,
# so back off rather than respawning ten times a second into the journal. One
# that did publish and then died is an ordinary restart and retries at once.
MAX_RETRY_SECONDS = 5.0


class Loopback:
    def __init__(self, name: str, view: Graph, latency_ms: int) -> None:
        self._name = name
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

    def reconcile(self, source: Node, sink: Node) -> None:
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
            self._spawn(source, sink)
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
        self.ready = True

    def _spawn(self, source: Node, sink: Node) -> None:
        self._generation += 1
        self._node_name = f"{PLAYBACK_NODE}_{self._name}_{os.getpid()}_{self._generation}"
        common = {
            "node.dont-fallback": True,
            "node.dont-reconnect": True,
            "node.dont-move": True,
            "state.restore-props": False,
            "node.stream.restore-props": False,
            "node.stream.restore-target": False,
        }
        capture = {**common, "node.name": f"{self._node_name}_capture"}
        playback = {
            **common,
            "node.name": self._node_name,
            "media.name": self._name,
            SOURCE_PROPERTY: self._name,
            # PipeWire's adapter applies these before exporting the node, so
            # the stream is silent until the manager holds it at its trim.
            "node.param.Props": {"mute": False, "channelVolumes": [0.0, 0.0]},
        }
        self._process = subprocess.Popen(
            ["pw-loopback", "--capture", str(source["name"]),
             "--playback", str(sink["name"]), "--channels", "2",
             "--latency", str(self._latency_ms),
             "--capture-props", json.dumps(capture),
             "--playback-props", json.dumps(playback)],
            stdout=subprocess.DEVNULL,
        )
