"""What the microphone is sent so it can subtract the room's own playback.

A device that cancels echo in its own DSP needs the far-end reference: what the
speakers are playing, delivered ahead of the acoustic echo. On the ReSpeaker
arrays that is the output sink's monitor looped into the array's USB playback
endpoint - its physical speaker jack is unused, but the route is what lets the
device subtract our own output from the microphones.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

from .. import graph
from ..system import pactl
from ..config import EchoReferenceConfig
from ..graph import Graph, Node
from ..modules import ModuleRegistry, stream_media_name


LOG = logging.getLogger(__name__)

REFERENCE_ROLE = "_aec"


class EchoReference(Protocol):
    def reconcile(self, output: Node | None, *, wanted: bool = True) -> dict[str, Any]:
        """Keep the reference flowing while wanted; answers with the status
        file's `aec_reference` section."""


class NoEchoReference:
    """A microphone that is sent nothing: it cancels no echo, or hears its own."""

    def reconcile(self, output: Node | None, *, wanted: bool = True) -> dict[str, Any]:
        return {
            "enabled": False,
            "available": False,
            "endpoints_available": False,
            "sink": None,
        }


class PlaybackEchoReference:
    """The output's monitor, looped into the device's own playback endpoint."""

    def __init__(
        self, config: EchoReferenceConfig, view: Graph, registry: ModuleRegistry
    ) -> None:
        self.config = config
        self._graph = view
        self._modules = registry

    def reconcile(self, output: Node | None, *, wanted: bool = True) -> dict[str, Any]:
        reference_sink = self._graph.find_sink(self.config.sink_match)
        monitor = (
            self._graph.source_named(graph.monitor_name(output["name"]))
            if output
            else None
        )
        endpoints_available = bool(reference_sink and monitor)
        available = False
        if self.config.enabled and wanted and reference_sink and monitor:
            # Unity restores a stable reference baseline; DSP headroom and
            # cancellation quality still need measurement.
            sink_ready = self._pin_sink(reference_sink)
            created = self._modules.ensure_loopback(
                REFERENCE_ROLE,
                monitor["name"],
                reference_sink["name"],
                self.config.latency_ms,
            )
            if created:
                LOG.info("Enabled the echo-cancellation far-end reference")
            available = self._pin_stream() and sink_ready
        else:
            self._modules.unload(REFERENCE_ROLE)
        return {
            "enabled": self.config.enabled,
            "available": available,
            "endpoints_available": endpoints_available,
            "sink": reference_sink.get("name") if reference_sink else None,
        }

    def _pin_sink(self, sink: Node) -> bool:
        state = graph.volume_state(sink)
        if state is None:
            return False
        if not graph.volume_is(sink, 100):
            pactl.set_sink_volume(sink["name"], 100)
            LOG.info("Pinned the echo reference sink to 100%%")
        if state[1]:
            pactl.set_sink_mute(sink["name"], False)
            LOG.info("Unmuted the echo reference sink")
        return True

    def _pin_stream(self) -> bool:
        stream = graph.find_owned_stream(
            self._graph.sink_inputs,
            self._modules.id_of(REFERENCE_ROLE),
            stream_media_name(REFERENCE_ROLE),
        )
        if stream is None:
            return False
        state = graph.volume_state(stream)
        if state is None:
            return False
        index = int(stream["index"])
        if not graph.volume_is(stream, 100):
            pactl.set_sink_input_volume(index, 100)
            LOG.info("Pinned the echo reference stream to 100%%")
        if state[1]:
            pactl.set_sink_input_mute(index, False)
            LOG.info("Unmuted the echo reference stream")
        return True
