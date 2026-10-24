"""The PipeWire modules this daemon owns, tracked by the role each one plays."""

from __future__ import annotations

import logging
from typing import Callable

from smartamp_audio import graph
from smartamp_audio import pactl
from smartamp_audio.graph import Graph


LOG = logging.getLogger(__name__)

Binding = tuple[str, ...]

# Every stream this daemon owns is tagged with a media.name under this prefix,
# which is how one is recognised again after PipeWire recreates its module.
STREAM_PREFIX = "SmartAmp."


def stream_media_name(role: str) -> str:
    return f"{STREAM_PREFIX}{role.strip('_')}"


# A loopback's playback stream is created at whatever volume WirePlumber
# restores for its media.name, full volume the first time. It cannot be asked
# to start silent: a `node.param.Props` entry in sink_input_properties makes
# pipewire-pulse 1.4 refuse the stream's node outright ("can't set node param:
# Operation not permitted"), so the module loads with no stream behind it and
# the bus never becomes available. The bridge is instead loaded behind the
# output's mute, held at nothing by its bus as soon as it is seen, and faded
# in once the mute lifts.
def stream_properties(role: str) -> str:
    """The `sink_input_properties` module argument for a role's stream."""
    return f"sink_input_properties=media.name={stream_media_name(role)}"


class ModuleRegistry:
    """Loads, adopts, and releases modules by role name.

    A role is a stable name like "_voice_bridge" or "aux"; the PipeWire module
    behind it may be recreated at any time. Listeners are told when a role's
    module goes away so whatever cached its stream can forget it.
    """

    def __init__(
        self, view: Graph, on_bridging: Callable[[str], None] | None = None
    ) -> None:
        """`on_bridging` is told the sink a new loopback is about to play
        into, before the module is loaded, so the output can be guarded."""
        self._graph = view
        self._on_bridging = on_bridging
        self._ids: dict[str, int] = {}
        self._bindings: dict[str, Binding] = {}
        self._listeners: list[Callable[[str], None]] = []

    def on_released(self, listener: Callable[[str], None]) -> None:
        self._listeners.append(listener)

    def __contains__(self, role: str) -> bool:
        return role in self._ids

    def id_of(self, role: str) -> int | None:
        return self._ids.get(role)

    def roles(self) -> list[str]:
        return list(self._ids)

    def load(self, role: str, module: str, *arguments: str) -> int:
        module_id = pactl.load_module(module, *arguments)
        self._ids[role] = module_id
        self._graph.invalidate()
        return module_id

    def adopt(self, role: str, module_id: int, binding: Binding = ()) -> None:
        """Take ownership of a module a previous run of this daemon left behind."""
        self._ids[role] = module_id
        if binding:
            self._bindings[role] = binding

    def unload(self, role: str) -> None:
        module_id = self._ids.get(role)
        if module_id is not None:
            # Keep the role tracked until PipeWire confirms the unload. If the
            # graph races us, the next reconcile can retry or drop it from the
            # fresh module listing.
            pactl.unload_module(module_id)
            del self._ids[role]
        self._bindings.pop(role, None)
        self._announce(role)
        if module_id is not None:
            self._graph.invalidate()

    def drop_released(self) -> None:
        """Forget roles whose module PipeWire removed underneath us."""
        loaded = {int(module["index"]) for module in self._graph.modules}
        for role, module_id in list(self._ids.items()):
            if module_id in loaded:
                continue
            del self._ids[role]
            self._bindings.pop(role, None)
            self._announce(role)
            LOG.info("PipeWire removed %s; it will be recreated", role)

    def ensure_loopback(
        self,
        role: str,
        source: str,
        sink: str,
        latency_ms: int,
        *,
        channels: int | None = None,
    ) -> bool:
        """`channels` narrows the loopback's own streams: a mono loopback from
        a stereo source has PipeWire mix both channels into one, and plays
        that one mix on every channel of the sink."""
        return self._ensure(
            role,
            "module-loopback",
            binding=(source, sink),
            adopt_arguments=(f"source={source}", f"sink={sink}"),
            arguments=(
                f"source={source}",
                f"sink={sink}",
                f"latency_msec={latency_ms}",
                *(() if channels is None else (f"channels={channels}",)),
                "source_dont_move=true",
                "sink_dont_move=true",
                stream_properties(role),
            ),
            before_load=lambda: self._announce_bridging(sink),
        )

    def _ensure(
        self,
        role: str,
        module: str,
        *,
        binding: Binding,
        adopt_arguments: Binding,
        arguments: Binding,
        before_load: Callable[[], None] | None = None,
    ) -> bool:
        """Load the module for a role unless an equivalent one already runs."""
        if self._bindings.get(role) not in (None, binding):
            self.unload(role)
        if role not in self._ids:
            existing = graph.find_loaded_module(
                self._graph.modules, module, adopt_arguments
            )
            if existing is not None:
                self.adopt(role, int(existing["index"]), binding)
        if role in self._ids:
            return False
        if before_load is not None:
            before_load()
        self.load(role, module, *arguments)
        self._bindings[role] = binding
        return True

    def _announce(self, role: str) -> None:
        for listener in self._listeners:
            listener(role)

    def _announce_bridging(self, sink: str) -> None:
        if self._on_bridging is not None:
            self._on_bridging(sink)
