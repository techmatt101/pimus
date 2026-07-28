"""Named null sinks bridged into the output, each carrying its own gain.

A bus exists so a whole class of playback (background music, voice) lands on
one persistent loopback stream whose volume this daemon owns; clients are
pointed at the null sink by their unit's PULSE_SINK. Holding the gain on that
long-lived bridge is what stops a fresh stream playing a syllable at full
level before its volume applies.
"""

from __future__ import annotations

import logging

from . import graph, volume
from .config import BackgroundConfig, BusConfig, VoiceBusConfig
from .graph import Graph, Node
from .modules import ModuleRegistry, stream_media_name


LOG = logging.getLogger(__name__)


class AudioBus:
    def __init__(
        self,
        prefix: str,
        config: BusConfig,
        description: str,
        view: Graph,
        registry: ModuleRegistry,
    ) -> None:
        self.prefix = prefix
        self.config = config
        self.description = description
        self.sink_role = f"_{prefix}_sink"
        self.bridge_role = f"_{prefix}_bridge"
        self.sink: Node | None = None
        self.stream_index: int | None = None
        self.gain_applied: int | None = None
        self._graph = view
        self._modules = registry
        registry.on_released(self._role_released)

    @property
    def available(self) -> bool:
        return self.sink is not None and self.stream_index is not None

    @property
    def monitor_name(self) -> str:
        """The source carrying exactly what this bus is playing."""
        return graph.monitor_name(self.config.sink_name)

    def reconcile(self, output: Node | None) -> Node | None:
        """Keep the null sink and its bridge into the output in place."""
        if not self.config.enabled:
            self.release()
            self.sink = None
            return None
        self.sink = self._ensure_sink()
        monitor = self._graph.source_named(graph.monitor_name(self.config.sink_name))
        if not (output and monitor):
            self._modules.unload(self.bridge_role)
            return self.sink
        created = self._modules.ensure_loopback(
            self.bridge_role,
            monitor["name"],
            output["name"],
            self.config.latency_ms,
        )
        if created:
            LOG.info("Connected %s audio to the output", self.prefix)
        bridge = graph.find_owned_stream(
            self._graph.sink_inputs,
            self._modules.id_of(self.bridge_role),
            stream_media_name(self.bridge_role),
        )
        self._track_stream(int(bridge["index"]) if bridge is not None else None)
        # Reconcile against the graph, not only our last successful write. A
        # stream can be recreated or changed underneath the module that owns it.
        live_gain = graph.volume_state(bridge) if bridge is not None else None
        self.gain_applied = live_gain[0] if live_gain is not None else None
        return self.sink

    def release(self) -> None:
        self._modules.unload(self.bridge_role)
        self._modules.unload(self.sink_role)

    def apply_gain(self, target: int) -> None:
        if self.stream_index is None or self.gain_applied == target:
            return
        self._write_gain(target, fade_ms=0)

    def _write_gain(self, target: int, fade_ms: int) -> None:
        if self.stream_index is None:
            return
        start = self.gain_applied if self.gain_applied is not None else target
        volume.fade_stream(self.stream_index, start, target, fade_ms)
        self.gain_applied = target

    def _ensure_sink(self) -> Node | None:
        sink = self._graph.sink_named(self.config.sink_name)
        if sink is None:
            if self.sink_role not in self._modules:
                self._modules.load(
                    self.sink_role,
                    "module-null-sink",
                    f"sink_name={self.config.sink_name}",
                    # priority.session=1 keeps WirePlumber from ever electing
                    # the bus as its own default sink.
                    f"sink_properties=device.description={self.description}"
                    " priority.session=1",
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
        # A recreated bridge stream starts at full volume, so forget what was
        # applied to the old one and let the next gain snap it into place.
        self.stream_index = stream_index
        self._forget_gain()

    def _forget_gain(self) -> None:
        self.gain_applied = None

    def _role_released(self, role: str) -> None:
        if role == self.bridge_role:
            self.stream_index = None
            self._forget_gain()


class BackgroundBus(AudioBus):
    """The Sendspin/USB bus, dipped while the voice assistant is talking."""

    config: BackgroundConfig
    ducked: bool | None = None

    def __init__(
        self, config: BackgroundConfig, view: Graph, registry: ModuleRegistry
    ) -> None:
        super().__init__(
            "background", config, "SmartAmp_Background_Audio", view, registry
        )

    def target_gain(self, music_volume: int, ducked: bool) -> int:
        """The bridge gain for the music level, dipped by the duck share."""
        if not ducked:
            return music_volume
        return volume.scale(music_volume, self.config.duck_volume_percent)

    def apply_ducking(self, music_volume: int, ducked: bool) -> None:
        if self.stream_index is None:
            return
        target = self.target_gain(music_volume, ducked)
        if self.ducked == ducked and self.gain_applied == target:
            return
        # A duck transition fades; the music level moving just snaps the gain,
        # tracking the detent that moved it.
        changed_duck = self.ducked != ducked
        fade_ms = self.config.fade_ms if changed_duck and self.ducked is not None else 0
        self._write_gain(target, fade_ms)
        self.ducked = ducked
        if changed_duck:
            LOG.info("%s background audio", "Ducked" if ducked else "Restored")

    def _forget_gain(self) -> None:
        super()._forget_gain()
        self.ducked = None


class VoiceBus(AudioBus):
    """Voice playback's own bus, so TTS has a level independent of the music.

    The voice assistant plays TTS, timers, and announcements straight to the
    default sink, which is also where music plays; putting its playback on a
    bus of its own is what lets a voice level be held independently.
    """

    config: VoiceBusConfig

    def __init__(
        self, config: VoiceBusConfig, view: Graph, registry: ModuleRegistry
    ) -> None:
        super().__init__("voice", config, "SmartAmp_Voice_Audio", view, registry)
