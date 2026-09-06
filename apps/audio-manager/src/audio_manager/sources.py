"""The mixer's channels: every music input, held at its own trim on the bus.

The daemon knows no input by how it reaches the bus. A stream playing into the
music bus belongs to the source its `smartamp.source` property names, and a
stream with no tag to the default source - which is what Sendspin, and anything
playing at the default sink, are. The inputs app tags the loopbacks it runs for
the USB gadget and the aux input; an external player is tagged by an
environment line on its unit. Each source has a trim held on its streams; one
inventory gave an `enabled` toggle is a route the deck can switch, and is held
silent while off. The bus's bridge carries the music level and the ducking, so
a stream here carries nothing but its source's share.
"""

from __future__ import annotations

import logging
from typing import Any

from smartamp_audio import graph, pactl, volume
from smartamp_audio.graph import Graph, Node
from .config import SourceConfig
from .modules import STREAM_PREFIX


LOG = logging.getLogger(__name__)

SOURCE_PROPERTY = "smartamp.source"

# Control-rate fade duration for a toggle; this is not a sample-level
# de-clicking ramp.
TOGGLE_FADE_MS = 200


class SourceMixer:
    """Desired trims and toggles live in memory; the controller owns them
    through the control socket and re-asserts them after either process
    restarts, and a restart comes back to the configured share."""

    def __init__(
        self, sources: dict[str, SourceConfig], default_source: str, view: Graph
    ) -> None:
        self._sources = sources
        self._default = default_source
        self._graph = view
        self.trims = {name: source.volume_percent for name, source in sources.items()}
        self.enabled = {
            name: bool(source.enabled)
            for name, source in sources.items()
            if source.switchable
        }
        # Which streams each source had on the last pass, and the level this
        # daemon last wrote to each stream, so a toggle can fade from it and a
        # recreated stream is recognised as needing its level again.
        self._found: dict[str, list[Node]] = {name: [] for name in sources}
        self._applied: dict[int, int] = {}

    def knows(self, name: str) -> bool:
        return name in self._sources

    def switchable(self, name: str) -> bool:
        return name in self.enabled

    def set_trim(self, name: str, percent: int) -> None:
        self.trims[name] = percent

    def set_enabled(self, name: str, enabled: bool) -> bool:
        """Record a route's requested state; returns whether it changed."""
        changed = self.enabled[name] != enabled
        self.enabled[name] = enabled
        return changed

    def level_of(self, name: str) -> int:
        """The gain a source's streams are held at: its trim, or silence
        while it is switched off."""
        return self.trims[name] if self.enabled.get(name, True) else 0

    def source_of(self, stream: Node) -> str | None:
        """Which source a stream on the bus belongs to, if any."""
        tag = graph.properties_of(stream).get(SOURCE_PROPERTY)
        name = self._default if tag is None else str(tag)
        return name if name in self._sources else None

    def silenced(self, stream: Node) -> bool:
        """Whether a stream belongs to a source that is switched off."""
        name = self.source_of(stream)
        return name is not None and not self.enabled.get(name, True)

    def status(self) -> dict[str, dict[str, Any]]:
        """Each source as the document lists it: its trim, its toggle if it
        has one, and whether the last pass found any of its streams."""
        return {
            name: {
                "trim": self.trims[name],
                **({"enabled": self.enabled[name]} if name in self.enabled else {}),
                "available": bool(self._found[name]),
            }
            for name in self._sources
        }

    def reconcile(self, bus: Node | None) -> None:
        """Hold every stream on the bus at its source's level, snapping any
        that drifted or just appeared. An input's loopback is born silent, so
        the snap that lands its trim is also what lets it be heard."""
        self._found = {name: [] for name in self._sources}
        if bus is None:
            self._applied.clear()
            return
        for stream in self._streams_on(bus):
            name = self.source_of(stream)
            if name is not None:
                self._found[name].append(stream)
        live: set[int] = set()
        for name, streams in self._found.items():
            for stream in streams:
                live.add(self._hold(stream, self.level_of(name), fade=False))
        for index in list(self._applied):
            if index not in live:
                del self._applied[index]

    def apply(self, name: str, bus: Node | None) -> None:
        """Move one source's streams to its level now, without reconciling:
        a trim moves snap, a toggle fades from the level last written."""
        if bus is None:
            return
        level = self.level_of(name)
        for stream in self._streams_on(bus):
            if self.source_of(stream) == name:
                self._hold(stream, level, fade=self.switchable(name))

    def _streams_on(self, bus: Node) -> list[Node]:
        index = bus.get("index")
        if index is None:
            return []
        return [
            stream
            for stream in self._graph.sink_inputs
            if str(stream.get("sink")) == str(index)
            and not graph.media_name(stream).startswith(STREAM_PREFIX)
        ]

    def _hold(self, stream: Node, level: int, *, fade: bool) -> int:
        index = int(stream["index"])
        if graph.volume_is(stream, level):
            self._applied[index] = level
            return index
        # A failed write may already have changed the stream. Only cache a
        # level once the write succeeds, so a retry snaps rather than fades
        # from a level that was never reached.
        previous = self._applied.pop(index, None)
        if fade and previous is not None:
            volume.fade_stream(index, previous, level, TOGGLE_FADE_MS)
        else:
            pactl.set_sink_input_volume(index, level)
        self._applied[index] = level
        LOG.info("Holding stream %s at %s%%", index, level)
        return index
