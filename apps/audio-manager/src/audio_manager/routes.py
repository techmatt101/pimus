"""The switchable input routes: aux, USB, and anything else in the config."""

from __future__ import annotations

import logging
from typing import Any

from . import graph, pactl, volume
from .config import SourceConfig
from .graph import Graph, Node
from .modules import ModuleRegistry, stream_media_name


LOG = logging.getLogger(__name__)

# How long a mute_when_off route takes to fade between silent and full when
# toggled. A code constant rather than configuration: it only needs to be slow
# enough that a DC step becomes an inaudible ramp.
ROUTE_FADE_MS = 200


def activate_parked_card(view: Graph, pattern: str) -> None:
    # The UAC2 gadget's ALSA card exposes no mixer controls, so the card
    # profiler offers only "off" and "pro-audio" and WirePlumber activates
    # neither on its own; the card boots parked off with no capture node.
    # Switch a matching parked card on and let the resulting graph event
    # schedule the reconcile that finds its node.
    card = view.find_card(pattern)
    if card is None or card.get("active_profile") != "off":
        return
    profiles = card.get("profiles") or {}
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
        # The applied toggle state and stream identity of each mute_when_off
        # route. A new stream is snapped to the toggle before it can play at its
        # default full volume; an existing stream only fades on a state change.
        self.unmuted: dict[str, bool] = {}
        self.stream_indices: dict[str, int] = {}
        registry.on_released(self._role_released)

    def knows(self, name: str) -> bool:
        return name in self.enabled

    def set_enabled(self, name: str, enabled: bool) -> bool:
        """Record a route's requested state; returns whether it changed."""
        changed = self.enabled[name] != enabled
        self.enabled[name] = enabled
        return changed

    def reconcile(
        self,
        *,
        output: Node | None,
        background_sink: Node | None,
        music_volume: int,
        usb_playback: bool,
    ) -> dict[str, dict[str, Any]]:
        return {
            name: self._reconcile_source(
                name,
                source,
                output=output,
                background_sink=background_sink,
                music_volume=music_volume,
                usb_playback=usb_playback,
            )
            for name, source in self._sources.items()
        }

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
        usb_playback: bool,
    ) -> dict[str, Any]:
        node = self._graph.find_source(source.match)
        enabled = self.enabled.get(name, False)
        # The gadget's capture clock only ticks while the computer holds its
        # playback stream open; bridging a dead clock stalls the whole PipeWire
        # driver group, silencing every output. A host that is enumerated but
        # playing elsewhere leaves the clock just as dead as an unplugged
        # cable, so the gate is the streaming state, not the UDC file. Keep the
        # route's enabled flag but only build the loopback while audio is
        # actually arriving.
        attached = not source.requires_usb_host or usb_playback
        # Connecting an analogue route's stream pops: any DC offset on the
        # input lands as a step on the speakers, at full amp gain because only
        # PipeWire volume sits in the path. A mute_when_off route therefore
        # keeps its bridge loaded from boot and toggles by fading the stream
        # volume, so the connect happens exactly once.
        wanted = enabled or source.mute_when_off
        if node is None and wanted:
            activate_parked_card(self._graph, source.match)
        status = {
            "enabled": enabled,
            "available": node is not None and attached,
            "node": node.get("name") if node else None,
        }
        target = background_sink if source.bridges_into_background else output
        if not (wanted and attached and node is not None and target is not None):
            self._modules.unload(name)
            return status
        created = self._modules.ensure_loopback(
            name, node["name"], target["name"], source.latency_ms
        )
        if created and not source.mute_when_off:
            LOG.info("Enabled %s input monitor", name)
        stream = self._stream_of(name)
        if stream is None:
            return status
        # A route bridging into the background bus already gets the music level
        # from the bus bridge, so its stream carries only the input's own trim;
        # a route straight to the pinned output sink carries the trimmed music
        # level on its own stream instead.
        if source.bridges_into_background:
            self._track_level(stream, source.volume_percent)
        else:
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
        level = volume.scale(music_volume, source.volume_percent)
        if not source.mute_when_off:
            self._track_level(stream, level)
            return
        if self.stream_indices.get(name) != stream_index:
            # PipeWire can recreate a stream while its loopback module survives.
            # Treat that stream as unsettled so an off route cannot start at
            # full volume.
            self.stream_indices[name] = stream_index
            self.unmuted.pop(name, None)
        was_enabled = self.unmuted.get(name)
        if was_enabled == enabled:
            # Verify both sides of a settled toggle against the live graph.
            self._track_level(stream, level if enabled else 0)
            return
        if was_enabled is None:
            # A new stream starts at full volume; snap it to the toggle before
            # it is audible so a boot with the route off is silent.
            pactl.set_sink_input_volume(stream_index, level if enabled else 0)
            LOG.info("Bridged %s input %s", name, "unmuted" if enabled else "muted")
        else:
            volume.fade_stream(
                stream_index,
                level if was_enabled else 0,
                level if enabled else 0,
                ROUTE_FADE_MS,
            )
            LOG.info("%s %s input monitor", "Enabled" if enabled else "Muted", name)
        self.unmuted[name] = enabled

    def _track_level(self, stream: Node, level: int) -> None:
        state = graph.volume_state(stream)
        if state is None or state[0] != level:
            pactl.set_sink_input_volume(int(stream["index"]), level)

    def _role_released(self, role: str) -> None:
        # A rebuilt bridge is a fresh stream at full volume, so the next
        # reconcile must snap it to the toggle rather than assume it settled.
        self.unmuted.pop(role, None)
        self.stream_indices.pop(role, None)

    def _stream_of(self, name: str) -> Node | None:
        return graph.find_owned_stream(
            self._graph.sink_inputs, self._modules.id_of(name), stream_media_name(name)
        )
