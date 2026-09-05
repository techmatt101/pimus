"""Output unity gain, saved user mute, and temporary protection during rebuilds."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from . import graph
from .system import pactl
from .graph import Graph, Node
from .modules import STREAM_PREFIX
from .status import write as write_state


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
    """Keep requested mute independent of WirePlumber's restored guard mute."""

    def __init__(self, match: str, view: Graph, mute_path: Path) -> None:
        self.match = match
        self.node: Node | None = None
        self._graph = view
        self._mute_path = mute_path
        self._muted = self._load_mute()
        self._guarded: Identity | None = None
        self._known: Identity | None = None
        self._observed: bool | None = None

    @property
    def muted(self) -> bool:
        return self._muted is True

    def remember_mute(self, muted: bool) -> None:
        if muted == self._muted:
            return
        write_state(self._mute_path, {"muted": muted})
        self._muted = muted

    def _load_mute(self) -> bool | None:
        try:
            saved = json.loads(self._mute_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        if not isinstance(saved, dict) or not isinstance(saved.get("muted"), bool):
            raise ValueError(f"Invalid output mute state: {self._mute_path}")
        return saved["muted"]

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
            self._observed = None
            return None
        observed = mute_state(sink)
        if self.guarded:
            if observed is False:
                self._apply_mute(True)
                observed = True
        elif observed is not None and (
            self._muted is None
            or (self._known == identity(sink) and observed != self._observed)
        ):
            self.remember_mute(observed)
        self._observed = observed
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
        # Save intent before muting: a killed process leaves only this record
        # to distinguish the guard from a user mute on the next start.
        self.remember_mute(self.muted)
        self._apply_mute(True)
        self._guarded = identity(sink)

    def settle(self, settled: bool) -> None:
        sink = self.node
        if sink is None:
            return
        if self.guarded:
            if settled:
                self._apply_mute(self.muted)
                self._guarded = None
            return
        if self._observed is not None and self._observed != self.muted:
            self._apply_mute(self.muted)

    def request_mute(self, muted: bool) -> None:
        self.remember_mute(muted)
        self._graph.invalidate()
        sink = self.find()
        if sink is None:
            raise RuntimeError("no output sink to mute")
        self._observed = mute_state(sink)
        self._apply_mute(muted or self.guarded)

    def _apply_mute(self, muted: bool) -> None:
        if self.node is None:
            raise RuntimeError("no output sink to mute")
        set_mute(self.node, muted)
        self._observed = muted
