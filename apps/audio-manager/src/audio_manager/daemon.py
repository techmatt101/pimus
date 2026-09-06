"""The reconcile loop: one place that decides what the graph should look like."""

from __future__ import annotations

import json
import logging
import selectors
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import output
from smartamp_audio import status, volume
from .system import amixer
from smartamp_audio import monitors, pactl
from .buses.background import BackgroundBus
from .buses.music_volume import MusicVolumeSync
from .buses.voice import VoiceBus
from .buses.voice_meter import VoiceLevelMeter
from .config import AudioConfig
from .control.commands import CommandHandler
from smartamp_audio.server import ControlServer
from smartamp_audio.graph import Graph, Node
from .idle import IdleTracker, playing_clients
from .modules import ModuleRegistry
from .routes import SourceRoutes
from .microphone.microphone import MicrophoneStatus, build as build_microphone


LOG = logging.getLogger(__name__)

# A burst of pactl subscribe events (device hotplug, PipeWire restart) settles
# into one reconcile scheduled this far ahead of the first event.
EVENT_DEBOUNCE_SECONDS = 0.3

# A transient graph race should heal promptly rather than waiting for the
# normal fifteen-minute safety resync.
RECONCILE_RETRY_SECONDS = 1.0

# Failures that mean the graph moved under us or a helper is missing: log them
# and try again on the next pass rather than terminating the daemon.
GRAPH_ERRORS = (subprocess.SubprocessError, json.JSONDecodeError, RuntimeError, OSError)


@dataclass(frozen=True)
class GraphStatus:
    """What one pass over the graph found, as the status file describes it.

    The rest of the document is manager state that outlives a pass, so only
    these have to be carried out of the rebuild.
    """

    microphone: MicrophoneStatus
    sources: dict[str, dict[str, Any]]


class AudioManager:
    def __init__(self, config: AudioConfig, socket_path: Path, status_path: Path) -> None:
        self.config = config
        self.status_path = status_path
        self.running = True
        self.music_volume = config.startup_volume_percent
        self.vol_muted = False
        self.voice_volume = config.voice_bus.volume_percent
        # The amplifier's hardware ceiling, refreshed by each reconcile rather
        # than read per query: it is set once at boot and only a hand at the
        # mixer moves it. None until the first pass, and on a unit whose card
        # cannot be read at all.
        self.output_ceiling: int | None = None

        self.graph = Graph()
        self.output = output.OutputSink(config.output_match, self.graph)
        self.modules = ModuleRegistry(self.graph, self._guard_output)
        self.background = BackgroundBus(config.background, self.graph, self.modules)
        self.selector = selectors.DefaultSelector()
        self.voice_meter = VoiceLevelMeter(self.selector, self._publish_voice_level)
        self.voice_bus = VoiceBus(
            config.voice_bus, self.graph, self.modules, self.voice_meter
        )
        self.microphone = build_microphone(config.microphone, self.graph, self.modules)
        self.routes = SourceRoutes(config.sources, self.graph, self.modules)
        self.music_register = MusicVolumeSync()
        self.idle = IdleTracker(config.idle_teardown_seconds)

        self.commands = CommandHandler(self)
        self.control = ControlServer(
            socket_path, self.selector, self.commands, self._reconcile_and_broadcast
        )
        self.graph_events = monitors.graph_events(
            self.selector, self.schedule_reconcile, self._subscribe_restarted
        )

        self.pending_reconcile: float | None = None
        self.next_resync = 0.0
        self._last_broadcast = self.state_event()

    def stop(self, *_args: object) -> None:
        self.running = False

    def execute(self) -> int:
        try:
            return self._run()
        finally:
            self._close()

    def _run(self) -> int:
        self.wait_for_pulse()
        if not self.running:
            return 0
        self.control.start()
        self.graph_events.start()
        self.safe_reconcile()
        while self.running:
            self._wait_for_work()
            self.graph_events.tick()
            self._reconcile_when_due()
            # After the reconcile, so a pass that just published the voice
            # monitor can start metering it without waiting for the next wake.
            self.voice_meter.tick()
            # A client can move the bus volume independently of the controller.
            self._broadcast_changes()
        return 0

    def _close(self) -> None:
        self.running = False
        self._guard(
            "Withdrawing audio status", lambda: self.status_path.unlink(missing_ok=True)
        )
        for description, close in (
            ("Stopping graph events", self.graph_events.stop),
            ("Closing control socket", self.control.close),
            ("Closing voice meter", self.voice_meter.close),
            ("Closing selector", self.selector.close),
        ):
            self._guard(description, close)
        for role in reversed(self.modules.roles()):
            self._guard(
                f"Releasing {role}",
                lambda role=role: self.modules.unload(role),
            )

    def wait_for_pulse(self) -> None:
        while self.running:
            if pactl.server_ready():
                return
            LOG.info("Waiting for PipeWire Pulse")
            time.sleep(1)

    def state_event(self) -> dict[str, Any]:
        return {
            "event": "state",
            "sources": dict(self.routes.enabled),
            "ducked": self.desired_ducking(),
            "music_volume": self.music_volume,
            "vol_muted": self.vol_muted,
            "voice_volume": self.voice_volume,
            "trims": self.trims(),
            "output_ceiling": self.output_ceiling,
        }

    def trims(self) -> dict[str, int]:
        """Every input trim this unit has, as the levels page reads them.

        The players' bus carries one of its own for whatever plays into it
        without a route, which is every client the daemon never hears about.
        """
        trims = dict(self.routes.trims)
        if self.config.background.enabled:
            trims["background"] = self.background.client_trim
        return trims

    def set_input_trim(self, name: str, percent: float) -> None:
        level = volume.clamp(percent)
        if name == "background":
            self._apply_or_retry(
                "Background trim", lambda: self._apply_background_trim(level)
            )
            return
        self.routes.set_trim(name, level)
        self._apply_or_retry(
            "Input trim", lambda: self._apply_route_trim(name)
        )

    def knows_trim(self, name: str) -> bool:
        return name in self.trims()

    @property
    def music_level(self) -> int:
        """The gain every music path plays at: the music level, or silence.

        The volume mute is this one substitution. The buses and routes never
        learn of it, the voice bus keeps its own level, and the music level
        itself is untouched so an unmute lands exactly where the dial was.
        """
        return 0 if self.vol_muted else self.music_volume

    def desired_ducking(self) -> bool:
        return self.config.background.ducking_enabled and self.commands.duck_requested

    def apply_ducking(self) -> bool:
        ducked = self.desired_ducking()
        self.background.apply_ducking(self.music_level, ducked)
        return ducked

    def safe_apply_ducking(self) -> None:
        self._apply_or_retry("Audio ducking", self.apply_ducking)

    def request_voice_meter(self, wanted: bool) -> None:
        self.voice_meter.request(wanted)
        self.voice_meter.tick()

    def set_voice_volume(self, percent: float) -> None:
        self.voice_volume = volume.clamp(percent)
        self._apply_or_retry(
            "Voice volume", lambda: self.voice_bus.apply_gain(self.voice_volume)
        )

    def set_music_volume(self, percent: float) -> None:
        self.music_volume = volume.clamp(percent)
        # Seed the public register from this explicit command.
        self.music_register.forget()
        self._apply_or_retry("Music volume", self._apply_music_volume)

    def set_music_mute(self, muted: bool) -> None:
        self.vol_muted = muted
        self.music_register.forget()
        self._apply_or_retry("Volume mute", self._apply_music_volume)

    def schedule_reconcile(self, delay: float = EVENT_DEBOUNCE_SECONDS) -> None:
        deadline = time.monotonic() + delay
        if self.pending_reconcile is None or deadline < self.pending_reconcile:
            self.pending_reconcile = deadline

    def safe_reconcile(self) -> bool:
        # Cleared first, so a pass that finds a bridge unsettled can book its
        # own follow-up.
        self.pending_reconcile = None
        succeeded = self._guard("Audio reconciliation", self.reconcile)
        if not succeeded:
            self._guard(
                "Clearing stale audio status",
                lambda: self.status_path.unlink(missing_ok=True),
            )
        delay = (
            self.config.resync_seconds if succeeded else RECONCILE_RETRY_SECONDS
        )
        self.next_resync = time.monotonic() + delay
        return succeeded

    def reconcile(self) -> None:
        self.graph.invalidate()
        self.modules.drop_released()
        sink = self.output.prepare()
        self._read_output_ceiling()
        idle = self.idle.update(self._audio_active())
        found = self._reconcile_graph(sink, idle)
        settled = self.background.settled and self.voice_bus.settled and self.routes.settled
        if not settled:
            self.schedule_reconcile(RECONCILE_RETRY_SECONDS)
        self.output.settle(settled)
        self._publish(sink, found)

    def _sync_music_register(self, background_sink: Node | None) -> None:
        before = (self.music_volume, self.vol_muted)
        after = self.music_register.sync(background_sink, before, self.graph)
        if after == before:
            return
        self.music_volume, self.vol_muted = after

    def _read_output_ceiling(self) -> None:
        ceiling = self.config.output_ceiling
        if not ceiling.readable:
            return
        self.output_ceiling = amixer.playback_percent(ceiling.card, ceiling.control)

    def _guard_output(self, sink_name: str) -> None:
        if sink_name in (
            self.output.name,
            self.background.sink_name,
            self.voice_bus.sink_name,
        ):
            self.output.guard()

    def _reconcile_graph(self, sink: Node | None, idle: bool) -> GraphStatus:
        """Put the buses, microphone and routes back where they belong."""
        background_sink = self.background.reconcile(sink, bridged=not idle)
        self._sync_music_register(background_sink)
        self.voice_bus.reconcile(sink, bridged=not idle)
        self.voice_bus.apply_gain(self.voice_volume)
        microphone = self.microphone.reconcile(sink, awake=not idle)
        self.apply_ducking()
        self._adopt_defaults(sink, microphone.source, background_sink)
        source_status = self.routes.reconcile(
            output=sink,
            background_sink=background_sink,
            music_volume=self.music_level,
            idle=idle,
        )
        output.hold_client_streams(self.graph, sink, self.music_level)
        return GraphStatus(microphone=microphone, sources=source_status)

    def _publish(self, sink: Node | None, found: GraphStatus) -> None:
        published = {
            "sink": sink.get("name") if sink else None,
            "music_volume": self.music_volume,
            "vol_muted": self.vol_muted,
            "output_ceiling": self.output_ceiling,
            "trims": self.trims(),
            "voice_input": found.microphone.device,
            "voice_capture": found.microphone.capture,
            "background": {
                **self.background.status(),
                "ducked": self.desired_ducking(),
            },
            "voice_bus": {
                "enabled": self.config.voice_bus.enabled,
                **self.voice_bus.status(),
                "volume_percent": self.voice_volume,
            },
            "aec_reference": found.microphone.echo_reference,
            "sources": found.sources,
            "idle": self.idle.idle,
            "standby": self.idle.standby,
        }
        status.write(self.status_path, published)
        LOG.debug("reconciled: %s", json.dumps(published))

    def _audio_active(self) -> bool:
        """Anything that means sound is, or is about to be, in flight.

        A duck or meter request marks a voice session well before its first
        TTS stream exists, an enabled analogue route has no stream to watch,
        and everything else shows up as a client stream playing somewhere.
        """
        if self.commands.duck_requested:
            return True
        if self.commands.meter_listeners or self.routes.holds_awake():
            return True
        owned = {str(self.modules.id_of(role)) for role in self.modules.roles()}
        return playing_clients(self.graph.sink_inputs, owned)

    def notice_voice_activity(self) -> None:
        self.idle.touch()
        if self.idle.idle:
            self.schedule_reconcile(0.0)

    def sync_standby(self) -> None:
        if not self.idle.set_standby(self.commands.standby_requested):
            return
        # A waking panel means someone is back in the room: rebuild now, so
        # the first thing they play or say opens on ready bridges.
        if not self.idle.standby:
            self.idle.touch()
        self.schedule_reconcile(0.0)

    def broadcast_state(self) -> None:
        self._last_broadcast = self.state_event()
        self.control.broadcast(self._last_broadcast)

    # Levels arrive many times a second and interest only whoever asked for
    # them, so they are addressed to the requesting connections rather than
    # broadcast to every client.
    def _publish_voice_level(self, level: float) -> None:
        event = {"event": "voice_level", "level": round(level, 3)}
        for connection in self.commands.meter_listeners:
            self.control.send(connection, event)

    def _apply_music_volume(self) -> None:
        self.graph.invalidate()
        if self.config.background.enabled:
            self._sync_music_register(
                self.graph.sink_named(self.config.background.sink_name)
            )
        self.apply_ducking()
        self.routes.apply_music_volume(self.music_level)
        output.hold_client_streams(self.graph, self.output.find(), self.music_level)

    def _apply_background_trim(self, level: int) -> None:
        self.graph.invalidate()
        self.background.set_client_trim(level)

    def _apply_route_trim(self, name: str) -> None:
        self.graph.invalidate()
        self.routes.apply_trim(name, self.music_level)

    def _adopt_defaults(
        self,
        sink: Node | None,
        voice_source: Node | None,
        background_sink: Node | None,
    ) -> None:
        # A client that plays to the default is playing music, so it belongs on
        # the music bus, where it lands behind a trim and the music level rather
        # than straight at the pinned output. It is also the only sink a player
        # watching its own output device can find, which is what makes the bus
        # register reach one that was never told a sink name.
        default = background_sink or sink
        # Only set defaults that are wrong: an unconditional set-default emits a
        # subscribe event on every reconcile, which would echo into another
        # scheduled reconcile and never quiesce.
        if default and pactl.default_sink() != default["name"]:
            pactl.set_default_sink(default["name"])
        if voice_source and pactl.default_source() != voice_source["name"]:
            pactl.set_default_source(voice_source["name"])

    def _wait_for_work(self) -> None:
        # Ducking is applied when a set-duck arrives, when a client holding a
        # request disconnects, and at the end of every reconcile, so the loop
        # needs no poll interval to notice a duck request.
        deadlines = [self.next_resync]
        monitor_deadline = self.graph_events.deadline()
        if monitor_deadline is not None:
            deadlines.append(monitor_deadline)
        if self.pending_reconcile is not None:
            deadlines.append(self.pending_reconcile)
        # The meter has to be started once its monitor appears, and stopped once
        # its hold past the last utterance lapses; neither is an event the
        # selector would otherwise wake for.
        meter_deadline = self.voice_meter.deadline()
        if meter_deadline is not None:
            deadlines.append(meter_deadline)
        # The quiet spell that earns an idle teardown ends without any event,
        # so the loop must wake itself when the bridges fall due for release.
        idle_deadline = self.idle.deadline()
        if idle_deadline is not None:
            deadlines.append(idle_deadline)
        deadline = min(deadlines)
        for key, _ in self.selector.select(max(0.0, deadline - time.monotonic())):
            key.data()

    def _reconcile_when_due(self) -> None:
        now = time.monotonic()
        idle_deadline = self.idle.deadline()
        if (
            now >= self.next_resync
            or (self.pending_reconcile is not None and now >= self.pending_reconcile)
            or (idle_deadline is not None and now >= idle_deadline)
        ):
            self.safe_reconcile()

    def _broadcast_changes(self) -> None:
        if self.state_event() != self._last_broadcast:
            self.broadcast_state()

    def _reconcile_and_broadcast(self) -> None:
        self.safe_reconcile()
        self.broadcast_state()

    def _subscribe_restarted(self) -> None:
        LOG.info("Restarted pactl subscribe")
        # Graph events may have been missed while the stream was down.
        self.schedule_reconcile(0.0)

    def _apply_or_retry(
        self, description: str, action: Callable[[], object]
    ) -> None:
        if not self._guard(description, action):
            self.schedule_reconcile(RECONCILE_RETRY_SECONDS)

    def _guard(self, description: str, action: Callable[[], object]) -> bool:
        try:
            action()
        except GRAPH_ERRORS as error:
            LOG.warning("%s failed: %s", description, error)
            return False
        return True
