"""A capture device bridged into the bus whenever the graph is awake: aux."""

from __future__ import annotations

from smartamp_audio.graph import Node
from .input import Input


class CaptureInput(Input):
    """An analogue input has no stream to watch and nothing to gate on, so
    its loopback runs for as long as the manager keeps the graph up: it is
    kept connected while off, because reconnecting a DC offset can click,
    and the manager holds it silent instead. While the graph is idle the
    loopback is dropped, or it would keep the card clocked for nothing."""

    def reconcile(self, bus: Node | None, awake: bool) -> None:
        source = self._find_device(activate=awake)
        self._play(source, bus, wanted=awake)
