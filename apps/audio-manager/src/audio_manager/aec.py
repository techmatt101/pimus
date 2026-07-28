"""The XVF3800's far-end acoustic-echo-cancellation reference.

The reference is what the room hears: the output sink's monitor looped into
the XVF3800 playback endpoint. That endpoint's physical speaker jack is unused,
but the route is what lets the device subtract our own output from the mic.
"""

from __future__ import annotations

import logging
from typing import Any

from . import graph
from .config import AecConfig
from .graph import Graph, Node
from .modules import ModuleRegistry


LOG = logging.getLogger(__name__)

REFERENCE_ROLE = "_aec"


class AecReference:
    def __init__(
        self, config: AecConfig, view: Graph, registry: ModuleRegistry
    ) -> None:
        self.config = config
        self._graph = view
        self._modules = registry

    def reconcile(self, output: Node | None) -> dict[str, Any]:
        reference_sink = self._graph.find_sink(self.config.sink_match)
        monitor = (
            self._graph.source_named(graph.monitor_name(output["name"]))
            if output
            else None
        )
        available = bool(reference_sink and monitor)
        if self.config.enabled and reference_sink and monitor:
            created = self._modules.ensure_loopback(
                REFERENCE_ROLE,
                monitor["name"],
                reference_sink["name"],
                self.config.latency_ms,
            )
            if created:
                LOG.info("Enabled XVF3800 AEC far-end reference")
        else:
            self._modules.unload(REFERENCE_ROLE)
        return {
            "enabled": self.config.enabled,
            "available": available,
            "sink": reference_sink.get("name") if reference_sink else None,
        }
