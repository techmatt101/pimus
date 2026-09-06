"""The local switchable input routes, such as the analogue aux input."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from smartamp_audio import graph, volume
from smartamp_audio import pactl
from .config import SourceConfig
from smartamp_audio.graph import Graph, Node, profiles_of
from .modules import ModuleRegistry, stream_media_name


LOG = logging.getLogger(__name__)

# Control-rate fade duration; this is not a sample-level de-clicking ramp.
ROUTE_FADE_MS = 200


@dataclass(frozen=True)
class AppliedRoute:
    """The toggle successfully applied to one particular playback stream."""

    stream_index: int
    enabled: bool


def activate_parked_card(view: Graph, pattern: str) -> None:
    # A configured input may boot parked off with no capture node.
    # Switch a matching parked card on and let the resulting graph event
    # schedule the reconcile that finds its node.
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


class SourceRoutes:
    """Every configured input, its on/off state, and its bridge into a sink.

    Desired route state lives in memory; the controller owns it through the
    control socket and re-asserts it after either process restarts.
    """

    def __init__(
        self,
        sources: dict[str, SourceConfig],
        view: Graph,
        registry: ModuleRegistry,
    ) -> None:
        self._sources = sources
        self._graph = view
        self._modules = registry
        self.enabled = {name: source.enabled for name, source in sources.items()}
        # Each input's trim starts where inventory put it and can be moved
        # live to balance the inputs against each other; a restart comes back
        # to the configured share.
        self.trims = {name: source.volume_percent for name, source in sources.items()}
        self._applied: dict[str, AppliedRoute] = {}
        self.settled = True
        registry.on_released(self._role_released)

    def knows(self, name: str) -> bool:
        return name in self.enabled

    def set_enabled(self, name: str, enabled: bool) -> bool:
        """Record a route's requested state; returns whether it changed."""
        changed = self.enabled[name] != enabled
        self.enabled[name] = enabled
        return changed

    def set_trim(self, name: str, percent: int) -> None:
        self.trims[name] = percent

    def reconcile(
        self,
        *,
        output: Node | None,
        background_sink: Node | None,
        music_volume: int,
        idle: bool = False,
    ) -> dict[str, dict[str, Any]]:
        self.settled = True
        return {
            name: self._reconcile_source(
                name,
                source,
                output=output,
                background_sink=background_sink,
                music_volume=music_volume,
                idle=idle,
            )
            for name, source in self._sources.items()
        }

    def holds_awake(self) -> bool:
        """Whether an enabled route needs the graph kept out of idle teardown.

        An enabled analogue input has no client stream to watch, so its
        toggle is the activity signal.
        """
        return any(self.enabled.values())

    def apply_trim(self, name: str, music_volume: int) -> None:
        """Move one route's stream to its trim, without reconciling.

        Unlike a music level move this includes a route bridged into the
        background bus: the bus carries the music gain for it, but the trim is
        held on the route's own stream either way.
        """
        source = self._sources.get(name)
        if source is None:
            return
        stream = self._stream_of(name)
        if stream is None:
            return
        self._apply_stream_level(
            name, source, stream, self.enabled.get(name, False), music_volume
        )

    def apply_music_volume(self, music_volume: int) -> None:
        """Move every stream this owns to the music level, without reconciling."""
        for name, source in self._sources.items():
            # Background-target routes play into the bus, which already carries
            # the music gain.
            if source.bridges_into_background:
                continue
            stream = self._stream_of(name)
            if stream is None:
                continue
            self._apply_stream_level(
                name,
                source,
                stream,
                self.enabled.get(name, False),
                music_volume,
            )

    def _reconcile_source(
        self,
        name: str,
        source: SourceConfig,
        *,
        output: Node | None,
        background_sink: Node | None,
        music_volume: int,
        idle: bool,
    ) -> dict[str, Any]:
        node = self._graph.find_source(source.match)
        enabled = self.enabled.get(name, False)
        # Keep analogue routes connected while awake: reconnecting a DC offset
        # can click even when the route is meant to be silent.
        wanted = enabled or (source.mute_when_off and not idle)
        if node is None and wanted:
            activate_parked_card(self._graph, source.match)
        status = {
            "enabled": enabled,
            "available": node is not None,
            "node": node.get("name") if node else None,
        }
        target = background_sink if source.bridges_into_background else output
        if not (wanted and node is not None and target is not None):
            self._modules.unload(name)
            return status
        created = self._modules.ensure_loopback(
            name, node["name"], target["name"], source.latency_ms
        )
        if created and not source.mute_when_off:
            LOG.info("Enabled %s input monitor", name)
        stream = self._stream_of(name)
        if stream is None:
            self.settled = False
            LOG.info("Waiting for the %s playback stream", name)
            return status
        self._apply_stream_level(name, source, stream, enabled, music_volume)
        return status

    def _apply_stream_level(
        self,
        name: str,
        source: SourceConfig,
        stream: Node,
        enabled: bool,
        music_volume: int,
    ) -> None:
        stream_index = int(stream["index"])
        # Background routes inherit the bus's music gain; both targets share
        # the same off/on handling and carry the input's own trim.
        trim = self.trims.get(name, source.volume_percent)
        level = (
            trim
            if source.bridges_into_background
            else volume.scale(music_volume, trim)
        )
        if not source.mute_when_off:
            self._track_level(stream, level)
            return
        # A recreated stream has no applied toggle, even if its module survived.
        applied = self._applied.get(name)
        was_enabled = (
            applied.enabled
            if applied is not None and applied.stream_index == stream_index
            else None
        )
        if was_enabled == enabled:
            # Verify both sides of a settled toggle against the live graph.
            self._track_level(stream, level if enabled else 0)
            return
        if was_enabled is None:
            pactl.set_sink_input_volume(stream_index, 0)
            if enabled:
                volume.fade_stream(stream_index, 0, level, ROUTE_FADE_MS)
            LOG.info("Bridged %s input %s", name, "unmuted" if enabled else "muted")
        else:
            volume.fade_stream(
                stream_index,
                level if was_enabled else 0,
                level if enabled else 0,
                ROUTE_FADE_MS,
            )
            LOG.info("%s %s input monitor", "Enabled" if enabled else "Muted", name)
        self._applied[name] = AppliedRoute(stream_index, enabled)

    def _track_level(self, stream: Node, level: int) -> None:
        if not graph.volume_is(stream, level):
            pactl.set_sink_input_volume(int(stream["index"]), level)

    def _role_released(self, role: str) -> None:
        # A rebuilt bridge is a fresh stream at full volume, so the next
        # reconcile must snap it to the toggle rather than assume it settled.
        self._applied.pop(role, None)

    def _stream_of(self, name: str) -> Node | None:
        return graph.find_owned_stream(
            self._graph.sink_inputs, self._modules.id_of(name), stream_media_name(name)
        )
