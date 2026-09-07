"""A named null sink bridged into the output, carrying its own gain.

A bus exists so a whole class of playback lands on one persistent loopback
stream whose volume this daemon owns. Holding the gain on that long-lived
bridge is what stops a fresh client stream playing a syllable at full level
before its volume applies.
"""

from __future__ import annotations

import logging
from typing import Any

from smartamp_audio import graph
from ..config import BusConfig
from ..fades import Fades
from smartamp_audio.graph import Graph, Node
from ..modules import ModuleRegistry, stream_media_name


LOG = logging.getLogger(__name__)

# How long a fresh bridge takes to come up from silence to its level. The
# bridge is rebuilt while a client is already playing into the bus, so its
# first instant is a step from nothing to the music, and on an amplifier that
# is a pop; a control-rate fade over a quarter second is not. It runs once
# per wake, after the output's guard has lifted, so the lift itself is silent.
WAKE_FADE_MS = 250


class PlaybackBus:
    def __init__(
        self,
        prefix: str,
        config: BusConfig,
        description: str,
        view: Graph,
        registry: ModuleRegistry,
        fades: Fades,
    ) -> None:
        self.prefix = prefix
        self.config = config
        self.description = description
        self.sink_role = f"_{prefix}_sink"
        self.bridge_role = f"_{prefix}_bridge"
        self.sink: Node | None = None
        self.stream_index: int | None = None
        self.gain_applied: int | None = None
        self.gain_wanted: int | None = None
        # A bridge stream this pass first saw: held silent until the output
        # is unguarded, then faded in.
        self.fresh = False
        # A module can finish loading before its stream appears.
        self.settled = True
        self._graph = view
        self._modules = registry
        self._fades = fades
        registry.on_released(self._role_released)

    @property
    def sink_name(self) -> str:
        return self.config.sink_name

    @property
    def available(self) -> bool:
        return self.sink is not None and self.stream_index is not None

    @property
    def monitor_name(self) -> str:
        """The source carrying exactly what this bus is playing."""
        return graph.monitor_name(self.config.sink_name)

    def status(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "sink": self.sink.get("name") if self.sink else None,
        }

    def reconcile(self, output: Node | None, *, bridged: bool = True) -> Node | None:
        """Keep the null sink in place, and its bridge into the output while
        wanted. An unbridged bus still accepts client streams — they just play
        into the retained null sink — so an idle teardown never breaks the
        clients pointed at it by PULSE_SINK."""
        self.settled = True
        if not self.config.enabled:
            self.release()
            self.sink = None
            return None
        self.sink = self._ensure_sink()
        monitor = self._graph.source_named(graph.monitor_name(self.config.sink_name))
        if not (bridged and output and monitor):
            self._modules.unload(self.bridge_role)
            return self.sink
        created = self._modules.ensure_loopback(
            self.bridge_role,
            monitor["name"],
            output["name"],
            self.config.latency_ms,
            silent=True,
        )
        if created:
            LOG.info("Connected %s audio to the output", self.prefix)
        bridge = graph.find_owned_stream(
            self._graph.sink_inputs,
            self._modules.id_of(self.bridge_role),
            stream_media_name(self.bridge_role),
        )
        if bridge is None:
            self._track_stream(None)
            self.settled = False
            LOG.info("Waiting for the %s playback bridge stream", self.prefix)
            return self.sink
        self._track_stream(int(bridge["index"]))
        # Reconcile against the graph, not only our last successful write. A
        # stream can be recreated or changed underneath the module that owns it.
        live_gain = graph.volume_state(bridge)
        actual = (
            live_gain[0]
            if live_gain is not None and graph.volume_is(bridge, live_gain[0])
            else None
        )
        if actual != self.gain_applied:
            self._fades.cancel(int(bridge["index"]))
        self.gain_applied = actual
        if self.fresh:
            LOG.info(
                "Found the %s playback bridge stream at %s%%",
                self.prefix,
                "?" if self.gain_applied is None else self.gain_applied,
            )
        return self.sink

    def release(self) -> None:
        self._modules.unload(self.bridge_role)
        self._modules.unload(self.sink_role)

    def apply_gain(self, target: int) -> None:
        self.gain_wanted = target
        if self.stream_index is None:
            return
        if self.fresh:
            self.hold_silent()
            return
        pending = self._fades.target(self.stream_index)
        if pending == target:
            return
        if self.gain_applied != target or pending is not None:
            self._write_gain(target, fade_ms=0)

    def hold_silent(self) -> None:
        """Keep a fresh bridge at nothing until it can be faded in. A bridge
        is born silent, so this normally writes nothing; it is the backstop
        for a stream that came up loud anyway."""
        if self.gain_applied != 0 or (
            self.stream_index is not None
            and self._fades.target(self.stream_index) is not None
        ):
            self._write_gain(0, fade_ms=0)

    def fade_in(self) -> None:
        """Bring a fresh bridge up to its level, once the output is unguarded."""
        if not self.fresh or self.stream_index is None or self.gain_wanted is None:
            return
        self._write_gain(self.gain_wanted, WAKE_FADE_MS)
        self.fresh = False
        LOG.info("Fading the %s bridge in to %s%%", self.prefix, self.gain_wanted)

    def _write_gain(self, target: int, fade_ms: int) -> None:
        if self.stream_index is None:
            return
        start = self.gain_applied if self.gain_applied is not None else target
        self._fades.set(self.stream_index, start, target, fade_ms, self._record_gain)

    def _record_gain(self, level: int | None) -> None:
        self.gain_applied = level

    def _ensure_sink(self) -> Node | None:
        sink = self._graph.sink_named(self.config.sink_name)
        if sink is None:
            if self.sink_role not in self._modules:
                self._modules.load(
                    self.sink_role,
                    "module-null-sink",
                    f"sink_name={self.config.sink_name}",
                    # priority.session=1 keeps WirePlumber from ever electing
                    # the bus as its own default sink; the manager names the
                    # default itself.
                    #
                    # monitor.channel-volumes=false keeps the sink's own volume
                    # off its monitor, which is what lets that volume be a
                    # control surface beside the gain rather than a second one
                    # in front of it. It is PipeWire's default, stated here
                    # because the bridge already carries the level: were it ever
                    # to change, a bus whose monitor also attenuated would play
                    # twice as quiet, and never louder than asked for.
                    f"sink_properties=device.description={self.description}"
                    " priority.session=1 monitor.channel-volumes=false",
                )
                LOG.info("Created %s audio sink", self.prefix)
            self._graph.invalidate()
            return self._graph.sink_named(self.config.sink_name)
        if self.sink_role not in self._modules:
            owner_module = sink.get("owner_module")
            if owner_module is not None:
                self._modules.adopt(self.sink_role, int(owner_module))
        return sink

    def _track_stream(self, stream_index: int | None) -> None:
        if stream_index == self.stream_index:
            return
        if self.stream_index is not None:
            self._fades.cancel(self.stream_index)
        # Whatever the old stream was held at says nothing about this one:
        # forget it, and treat the new stream as fresh until it is faded in.
        self.stream_index = stream_index
        self.fresh = stream_index is not None
        self._forget_gain()

    def _forget_gain(self) -> None:
        self.gain_applied = None

    def _role_released(self, role: str) -> None:
        if role == self.bridge_role:
            if self.stream_index is not None:
                self._fades.cancel(self.stream_index)
            self.stream_index = None
            self.fresh = False
            self._forget_gain()
