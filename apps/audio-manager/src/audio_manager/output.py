"""The output sink: pinned at full scale, muted on request, and guarded while a
bridge is rebuilt so nothing plays through the amplifier before its gain lands.

The sink is not the volume control — music and voice each carry their own
bridge gain — so it stays pinned at 100% (WirePlumber restores whatever it last
had) and the HiFiBerry hardware ceiling is the only cap above the bus gains.
"""

from __future__ import annotations

import logging

from . import graph
from .system import pactl
from .graph import Graph, Node
from .modules import STREAM_PREFIX


LOG = logging.getLogger(__name__)

# A sink's name plus its index: the index changes when PipeWire recreates the
# node, which is what tells a fresh device apart from the one last seen.
Identity = tuple[str, object]


def identity(sink: Node) -> Identity:
    return sink["name"], sink.get("index")


def mute_state(sink: Node) -> bool | None:
    """Whether the sink is muted, or None when it reports no volume."""
    state = graph.volume_state(sink)
    return None if state is None else state[1]


def set_mute(sink: Node, muted: bool) -> None:
    pactl.set_sink_mute(sink["name"], muted)
    LOG.info("Output sink %s", "muted" if muted else "unmuted")


def hold_client_streams(view: Graph, sink: Node | None, level: int) -> None:
    """Hold every stream on the sink that is not one of our bridges at a level.

    On the pinned output sink this stops a client that plays straight at the
    output landing at full amplifier level; on the background bus it holds the
    Sendspin player's stream at its configured trim.
    """
    if sink is None or sink.get("index") is None:
        return
    for stream in view.sink_inputs:
        if str(stream.get("sink")) != str(sink.get("index")):
            continue
        media = str((stream.get("properties") or {}).get("media.name", ""))
        if media.startswith(STREAM_PREFIX):
            continue
        if graph.volume_is(stream, level):
            continue
        pactl.set_sink_input_volume(int(stream["index"]), level)
        LOG.info("Holding client stream %s at %s%%", stream.get("index"), level)


class OutputSink:
    """The output sink as one pass finds it, its requested mute, and the guard.

    Mute is the one part of output loudness that does not live on a bus gain:
    silencing the sink silences music and voice together, which is what the
    controller's mute key means. `muted` is the requested state. A mute made by
    any other client rides in on the same subscribe event that scheduled the
    pass, and is adopted here, so the controller never has to poll for it.

    The guard is a second, temporary mute. A fresh loopback stream plays at
    full volume until its gain lands, which would pop the first instant of
    audio through the amplifier, so the sink is muted before any loopback into
    it is loaded and released only once every bridge carries its gain.
    """

    def __init__(self, match: str, view: Graph) -> None:
        self.match = match
        self.muted = False
        self.node: Node | None = None
        self._graph = view
        self._guarded: Identity | None = None
        self._known: Identity | None = None
        self._observed: bool | None = None

    @property
    def name(self) -> str | None:
        return self.node["name"] if self.node else None

    @property
    def guarded(self) -> bool:
        return self.node is not None and self._guarded == identity(self.node)

    def find(self) -> Node | None:
        self.node = self._graph.find_sink(self.match)
        return self.node

    def prepare(self) -> Node | None:
        """Start of a pass: adopt a mute made elsewhere, and pin the volume."""
        sink = self.find()
        if sink is None:
            self._known = None
            self._observed = None
            return None
        self._observed = mute_state(sink)
        if self.guarded:
            if self._observed is False:
                set_mute(sink, True)
        else:
            self._guarded = None
            # Only a sink met on an earlier pass can carry a mute made since by
            # another client. A sink this process sees for the first time gets
            # the requested state instead: WirePlumber restores mute across
            # restarts and reboots, so a guard a previous process died holding
            # would otherwise become a mute nobody asked for.
            if self._observed is not None and self._known == identity(sink):
                self.muted = self._observed
        self._known = identity(sink)
        if graph.channel_volumes(sink) and not graph.volume_is(sink, 100):
            self.guard()
            pactl.set_sink_volume(sink["name"], 100)
            LOG.info("Pinned the output sink to 100%%")
        return sink

    def guard(self) -> None:
        """Hold the sink muted until settle() is told every gain is in place."""
        sink = self.node
        if sink is None or self.guarded:
            return
        set_mute(sink, True)
        self._guarded = identity(sink)

    def settle(self, settled: bool) -> None:
        """End of a pass: release the guard once settled, then apply the request."""
        sink = self.node
        if sink is None:
            return
        if self.guarded:
            if settled:
                self._guarded = None
                set_mute(sink, self.muted)
            return
        if self._observed is not None and self._observed != self.muted:
            set_mute(sink, self.muted)

    def request_mute(self, muted: bool) -> None:
        self.muted = muted
        self._graph.invalidate()
        sink = self.find()
        if sink is None:
            raise RuntimeError("no output sink to mute")
        set_mute(sink, muted or self.guarded)
