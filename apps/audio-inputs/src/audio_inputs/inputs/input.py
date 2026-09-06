"""What every input shares: a device found by match, and a loopback to run."""

from __future__ import annotations

import logging
import selectors
from typing import Any, Callable

from smartamp_audio import pactl
from smartamp_audio.graph import Graph, Node, profiles_of
from smartamp_audio.monitors import LineMonitor
from ..config import InputConfig
from ..loopback import Loopback


LOG = logging.getLogger(__name__)


def activate_parked_card(view: Graph, pattern: str) -> None:
    # A configured input may boot parked off with no capture node. Switch a
    # matching parked card on and let the resulting graph event schedule the
    # pass that finds its node.
    card = view.find_card(pattern)
    if card is None or card.get("active_profile") != "off":
        return
    profiles = profiles_of(card)
    profile = next(
        (
            name
            for name in ("pro-audio", *profiles)
            if name in profiles and name != "off"
        ),
        None,
    )
    if profile is None:
        return
    pactl.set_card_profile(str(card["name"]), profile)
    view.invalidate()
    LOG.info("Activated %s profile on card %s", profile, card.get("name"))


class Input:
    """One device's way onto the bus. A subclass decides when the loopback
    should run; this class runs it, and reports what it found."""

    def __init__(self, name: str, config: InputConfig, view: Graph) -> None:
        self.name = name
        self.config = config
        self._graph = view
        self._loopback = Loopback(name, view, config.latency_ms)
        self._node: str | None = None
        self._wanted = False

    def watch(
        self, selector: selectors.BaseSelector, schedule: Callable[[], None]
    ) -> list[LineMonitor]:
        """Any child whose lines say this input's device changed."""
        return []

    def reconcile(self, bus: Node | None, awake: bool) -> None:
        raise NotImplementedError

    def stop(self) -> None:
        self._loopback.stop()

    @property
    def retry_seconds(self) -> float | None:
        """How soon to look again, while a wanted loopback is still starting."""
        if not self._wanted or self._loopback.ready:
            return None
        return self._loopback.retry_seconds

    def status(self) -> dict[str, Any]:
        return {"node": self._node, "playing": self._loopback.ready}

    def _find_device(self, activate: bool) -> Node | None:
        source = self._graph.find_source(self.config.match)
        if source is None and activate:
            activate_parked_card(self._graph, self.config.match)
        self._node = str(source["name"]) if source is not None else None
        return source

    def _play(self, source: Node | None, bus: Node | None, wanted: bool) -> None:
        self._wanted = wanted and source is not None and bus is not None
        if not self._wanted or source is None or bus is None:
            self._loopback.stop()
            return
        self._loopback.reconcile(source, bus)
