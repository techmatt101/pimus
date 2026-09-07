"""The reconcile loop: one place that decides what the graph should look like."""

from __future__ import annotations

import json
import logging
import selectors
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from . import output
from smartamp_audio import status, volume
from smartamp_audio import monitors, pactl
from .buses.music import MusicBus
from .buses.music_level import MusicLevel
from .buses.voice import VoiceBus
from .buses.voice_meter import VoiceLevelMeter
from .config import AudioConfig, SourceConfig
from .control.commands import CommandHandler
from .control.leases import Leases
from .echo_reference import EchoReference
from .fades import Fades
from smartamp_audio.server import ControlServer
from smartamp_audio.graph import Graph, Node
from .idle import IdleTracker, playing_clients
from .modules import ModuleRegistry
from .sources import SourceMixer
from .state import SavedState


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


class AudioManager:
    def __init__(
        self, config: AudioConfig, socket_path: Path, status_path: Path,
        *, state_path: Path | None = None,
    ) -> None:
        self.config = config
        self.status_path = status_path
        self.state_path = state_path
        self.running = True
        saved = SavedState.load(config, state_path)
        self.music = MusicLevel(saved.music_volume, saved.music_muted)

        self.graph = Graph()
        self.output = output.OutputSink(config.output_match, self.graph)
        self.ceiling = output.OutputCeiling(config.output_ceiling)
        self.modules = ModuleRegistry(self.graph, self._guard_output)
        self.fades = Fades()
        self.music_bus = MusicBus(config.music_bus, self.graph, self.modules, self.fades)
        self.selector = selectors.DefaultSelector()
        self.voice_meter = VoiceLevelMeter(self.selector, self._publish_voice_level)
        self.voice_bus = VoiceBus(
            config.voice_bus, self.graph, self.modules, self.voice_meter, self.fades,
            saved.voice_volume,
        )
        self.echo_reference = EchoReference(
            config.echo_reference, self.graph, self.modules
        )
        self.mixer = SourceMixer(saved.sources, config.default_source, self.graph, self.fades)
        # What the last pass found of the reference path; the document
        # reports it between passes, as it does everything a pass settles.
        self.aec_reference: dict[str, Any] = self.echo_reference.status()
        self.idle = IdleTracker(config.idle_teardown_seconds)

        self.leases = Leases()
        self.commands = CommandHandler(self, self.leases)
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
            result = self._run()
            if result == 0:
                self._guard("Saving audio state", self._save_state)
            return result
        finally:
            self._close()

    def _save_state(self) -> None:
        if self.state_path is None:
            return
        SavedState(
            self.music.volume,
            self.music.muted,
            self.voice_bus.volume,
            {
                name: SourceConfig(self.mixer.trims[name], self.mixer.enabled.get(name))
                for name in self.config.sources
            },
        ).save(self.state_path)

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
            self._apply_or_retry("Audio fade", self.fades.tick)
            # After the reconcile, so a pass that just published the voice
            # monitor can start metering it without waiting for the next wake.
            self.voice_meter.tick()
            # A client can move the bus volume independently of the controller.
            self._broadcast_changes()
        return 0

    def _close(self) -> None:
        self.running = False
        self.fades.clear()
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

    def document(self) -> dict[str, Any]:
        """Everything this daemon says about the graph, in one shape.

        The status file is this document; a state event is this document
        with `event` in front. Each bus section carries its own level, and
        each source its own trim, so a reader never joins two maps by name.
        """
        return {
            "sink": self.output.name,
            "output_volume": self.ceiling.volume,
            "music_bus": {
                **self.music_bus.status(),
                "ducked": self.desired_ducking(),
                "volume": self.music.volume,
                "muted": self.music.muted,
            },
            "voice_bus": {
                "enabled": self.config.voice_bus.enabled,
                **self.voice_bus.status(),
                "volume": self.voice_bus.volume,
            },
            "aec_reference": self.aec_reference,
            "sources": self.mixer.status(),
            "idle": self.idle.idle,
        }

    def state_event(self) -> dict[str, Any]:
        return {"event": "state", **self.document()}

    def set_source_trim(self, name: str, percent: float) -> None:
        self.mixer.set_trim(name, volume.clamp(percent))
        self._apply_or_retry("Source trim", lambda: self._apply_source(name))

    def set_source_enabled(self, name: str, enabled: bool) -> bool:
        """Switch a route; returns whether that changed anything."""
        if not self.mixer.set_enabled(name, enabled):
            return False
        if enabled:
            # A route coming on is someone back in the room: rebuild an idle
            # graph now rather than fade a stream up into an unbridged bus.
            self.notice_voice_activity()
        self._apply_or_retry("Source toggle", lambda: self._apply_source(name))
        return True

    def desired_ducking(self) -> bool:
        return self.config.music_bus.ducking_enabled and self.leases.duck_requested

    def apply_ducking(self) -> bool:
        ducked = self.desired_ducking()
        self.music_bus.apply_ducking(self.music.level, ducked)
        return ducked

    def safe_apply_ducking(self) -> None:
        self._apply_or_retry("Audio ducking", self.apply_ducking)

    def apply_voice_meter(self) -> None:
        self.voice_meter.request(bool(self.leases.meter_listeners))
        self.voice_meter.tick()

    def set_voice_volume(self, percent: float) -> None:
        self._apply_or_retry(
            "Voice volume", lambda: self.voice_bus.set_volume(percent)
        )

    def set_music_volume(self, percent: float) -> None:
        self.music.set_volume(percent)
        self._apply_or_retry("Music volume", self._apply_music_volume)

    def set_output_ceiling(self, percent: int) -> None:
        self._guard("Output ceiling", lambda: self.ceiling.set(percent))

    def set_music_mute(self, muted: bool) -> None:
        self.music.set_muted(muted)
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
        self.ceiling.read()
        idle = self.idle.update(self._audio_active())
        self._reconcile_graph(sink, idle)
        settled = self.music_bus.settled and self.voice_bus.settled
        if not settled:
            self.schedule_reconcile(RECONCILE_RETRY_SECONDS)
            for bus in (self.music_bus, self.voice_bus):
                bus.hold_silent()
                bus.fresh = bus.stream_index is not None
        self.output.settle(settled)
        # Only once the guard has lifted: a fresh bridge is silent while the
        # output unmutes, and the fade is what brings the music in.
        if settled:
            self.music_bus.fade_in()
            self.voice_bus.fade_in()
        self._publish()

    def _guard_output(self, sink_name: str) -> None:
        if sink_name in (
            self.output.name,
            self.music_bus.sink_name,
            self.voice_bus.sink_name,
        ):
            self.output.guard()

    def _reconcile_graph(self, sink: Node | None, idle: bool) -> None:
        """Put the buses, echo reference and mixer back where they belong."""
        music_sink = self.music_bus.reconcile(sink, bridged=not idle)
        self.music.sync_register(music_sink, self.graph)
        self.voice_bus.reconcile(sink, bridged=not idle)
        self.voice_bus.apply_level()
        self.aec_reference = self.echo_reference.reconcile(sink, wanted=not idle)
        self.apply_ducking()
        self._adopt_default_sink(sink, music_sink)
        self.mixer.reconcile(music_sink)
        output.hold_client_streams(self.graph, sink, self.music.level)

    def _publish(self) -> None:
        published = self.document()
        status.write(self.status_path, published)
        LOG.debug("reconciled: %s", json.dumps(published))

    def _audio_active(self) -> bool:
        """Anything that means sound is, or is about to be, in flight.

        A duck or meter request marks a voice session well before its first
        TTS stream exists, and everything else shows up as a client stream
        playing somewhere. A stream of a source that is switched off is
        silence, however busy the computer behind it: it must not keep the
        bridges up.
        """
        if self.leases.held:
            return True
        owned = {str(self.modules.id_of(role)) for role in self.modules.roles()}
        audible = [
            stream for stream in self.graph.sink_inputs if not self.mixer.silenced(stream)
        ]
        return playing_clients(audible, owned)

    def notice_voice_activity(self) -> None:
        self.idle.touch()
        if self.idle.idle:
            self.schedule_reconcile(0.0)

    def force_idle(self) -> None:
        """Release the bridges now if nothing is playing, to test the idle
        state without waiting out the quiet spell."""
        LOG.info("Idle forced from the control socket")
        self.idle.expire()
        self.schedule_reconcile(0.0)

    def broadcast_state(self) -> None:
        self._last_broadcast = self.state_event()
        self.control.broadcast(self._last_broadcast)

    # Levels arrive many times a second and interest only whoever asked for
    # them, so they are addressed to the requesting connections rather than
    # broadcast to every client.
    def _publish_voice_level(self, level: float) -> None:
        event = {"event": "voice_level", "level": round(level, 3)}
        for connection in self.leases.meter_listeners:
            self.control.send(connection, event)

    def _apply_music_volume(self) -> None:
        self.graph.invalidate()
        if self.config.music_bus.enabled:
            self.music.sync_register(
                self.graph.sink_named(self.config.music_bus.sink_name), self.graph
            )
        self.apply_ducking()
        output.hold_client_streams(self.graph, self.output.find(), self.music.level)

    def _apply_source(self, name: str) -> None:
        self.graph.invalidate()
        self.mixer.apply(name, self.graph.sink_named(self.config.music_bus.sink_name))

    def _adopt_default_sink(
        self, sink: Node | None, music_sink: Node | None
    ) -> None:
        # A client that plays to the default is playing music, so it belongs on
        # the music bus, where it lands behind a trim and the music level rather
        # than straight at the pinned output. It is also the only sink a player
        # watching its own output device can find, which is what makes the bus
        # register reach one that was never told a sink name.
        default = music_sink or sink
        # Only set defaults that are wrong: an unconditional set-default emits a
        # subscribe event on every reconcile, which would echo into another
        # scheduled reconcile and never quiesce.
        if default and pactl.default_sink() != default["name"]:
            pactl.set_default_sink(default["name"])

    def _wait_for_work(self) -> None:
        # Ducking is applied when a set-duck arrives, when a client holding a
        # request disconnects, and at the end of every reconcile, so the loop
        # needs no poll interval to notice a duck request.
        deadlines = [self.next_resync]
        fade_deadline = self.fades.deadline()
        if fade_deadline is not None:
            deadlines.append(fade_deadline)
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
