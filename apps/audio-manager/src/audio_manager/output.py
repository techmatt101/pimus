"""Output unity gain and the mute held while its streams rebuild."""

from __future__ import annotations

import logging

from smartamp_audio import graph
from smartamp_audio import pactl
from smartamp_audio.graph import Graph, Node
from .modules import STREAM_PREFIX


LOG = logging.getLogger(__name__)

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
    output landing at full amplifier level. The bus's own streams are the
    mixer's (sources.py), each held at its source's trim.
    """
    if sink is None or sink.get("index") is None:
        return
    for stream in view.sink_inputs:
        if str(stream.get("sink")) != str(sink.get("index")):
            continue
        if graph.media_name(stream).startswith(STREAM_PREFIX):
            continue
        if graph.volume_is(stream, level):
            continue
        pactl.set_sink_input_volume(int(stream["index"]), level)
        LOG.info("Holding client stream %s at %s%%", stream.get("index"), level)


class OutputSink:
    """Pin the output at unity and hold it muted while its streams rebuild.

    The daemon owns the sink's mute outright. There is no user mute here:
    silence is a music level of zero, so voice keeps playing, and a mute found
    on the sink at start-up is a guard an earlier daemon left behind, released
    once the first pass settles.
    """

    def __init__(self, match: str, view: Graph) -> None:
        self.match = match
        self.node: Node | None = None
        self._graph = view
        self._guarded: Identity | None = None
        self._known: Identity | None = None

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
        sink = self.find()
        if sink is None:
            self._known = None
            self._guarded = None
            return None
        if self._known != identity(sink):
            self.guard()
        self._known = identity(sink)
        if graph.channel_volumes(sink) and not graph.volume_is(sink, 100):
            self.guard()
            pactl.set_sink_volume(sink["name"], 100)
            LOG.info("Pinned the output sink to 100%%")
        return sink

    def guard(self) -> None:
        sink = self.node
        if sink is None or self.guarded:
            return
        set_mute(sink, True)
        self._guarded = identity(sink)

    def settle(self, settled: bool) -> None:
        sink = self.node
        if sink is None:
            return
        if self.guarded:
            if settled:
                set_mute(sink, False)
                self._guarded = None
            return
        # Nothing else is meant to mute the output; a mute WirePlumber
        # restored or another client left is undone rather than read back.
        if mute_state(sink) is True:
            set_mute(sink, False)
