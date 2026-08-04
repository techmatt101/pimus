"""The XVF3800's far-end acoustic-echo-cancellation reference.

The reference is what the room hears: the output sink's monitor looped into
the XVF3800 playback endpoint. That endpoint's physical speaker jack is unused,
but the route is what lets the device subtract our own output from the mic.
"""

from __future__ import annotations

import logging
from typing import Any

from .. import graph
from ..system import pactl
from ..config import AecConfig
from ..graph import Graph, Node
from ..modules import ModuleRegistry, stream_media_name


LOG = logging.getLogger(__name__)

REFERENCE_ROLE = "_aec"


class AecReference:
    def __init__(
        self, config: AecConfig, view: Graph, registry: ModuleRegistry
    ) -> None:
        self.config = config
        self._graph = view
        self._modules = registry

    def reconcile(self, output: Node | None, *, wanted: bool = True) -> dict[str, Any]:
        # With nothing playing there is no echo to subtract, so an idle
        # teardown (wanted=False) can release the reference and let the
        # XVF3800 playback endpoint suspend without costing the DSP anything.
        reference_sink = self._graph.find_sink(self.config.sink_match)
        monitor = (
            self._graph.source_named(graph.monitor_name(output["name"]))
            if output
            else None
        )
        available = bool(reference_sink and monitor)
        if self.config.enabled and wanted and reference_sink and monitor:
            # The DSP models the echo as this reference at the level the room
            # hears, so the whole path must be unity gain: WirePlumber restores
            # whatever the reference sink last had, and nothing else owns it. A
            # quiet or muted reference makes the XVF3800 under-subtract, which
            # sounds like a mic that cannot hear over the music.
            self._pin_sink(reference_sink)
            created = self._modules.ensure_loopback(
                REFERENCE_ROLE,
                monitor["name"],
                reference_sink["name"],
                self.config.latency_ms,
            )
            if created:
                LOG.info("Enabled XVF3800 AEC far-end reference")
            self._pin_stream()
        else:
            self._modules.unload(REFERENCE_ROLE)
        return {
            "enabled": self.config.enabled,
            "available": available,
            "sink": reference_sink.get("name") if reference_sink else None,
        }

    def _pin_sink(self, sink: Node) -> None:
        state = graph.volume_state(sink)
        if state is None:
            return
        level, muted = state
        if level != 100:
            pactl.set_sink_volume(sink["name"], 100)
            LOG.info("Pinned the AEC reference sink to 100%%")
        if muted:
            pactl.set_sink_mute(sink["name"], False)
            LOG.info("Unmuted the AEC reference sink")

    def _pin_stream(self) -> None:
        stream = graph.find_owned_stream(
            self._graph.sink_inputs,
            self._modules.id_of(REFERENCE_ROLE),
            stream_media_name(REFERENCE_ROLE),
        )
        if stream is None:
            return
        state = graph.volume_state(stream)
        if state is None or state[0] == 100:
            return
        pactl.set_sink_input_volume(int(stream["index"]), 100)
        LOG.info("Pinned the AEC reference stream to 100%%")
