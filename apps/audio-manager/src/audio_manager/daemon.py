"""The reconcile loop: one place that decides what the graph should look like."""

from __future__ import annotations

import json
import logging
import selectors
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from . import monitors, output, pactl, status, usb_gadget, voice_capture, volume
from .aec import AecReference
from .buses import BackgroundBus, VoiceBus
from .commands import CommandHandler
from .config import AudioConfig
from .control_server import ControlServer
from .graph import Graph, Node
from .modules import ModuleRegistry
from .routes import SourceRoutes
from .usb_volume import UsbVolumeSync
from .voice_capture import VoiceCapture


LOG = logging.getLogger(__name__)

# A burst of pactl subscribe events (device hotplug, PipeWire restart) settles
# into one reconcile scheduled this far ahead of the first event.
EVENT_DEBOUNCE_SECONDS = 0.3

# Plugging or unplugging the USB-C gadget cable, or the host opening or closing
# its playback stream, changes no PipeWire state, so pactl subscribe never
# reports it. The gadget's mixer monitor usually announces a stream open/close
# instantly; this poll is the fallback that also catches events raced while
# that monitor was restarting.
USB_HOST_POLL_SECONDS = 2.0

# A transient graph race should heal promptly rather than waiting for the
# normal fifteen-minute safety resync.
RECONCILE_RETRY_SECONDS = 1.0

# Failures that mean the graph moved under us or a helper is missing: log them
# and try again on the next pass rather than terminating the daemon.
GRAPH_ERRORS = (subprocess.SubprocessError, json.JSONDecodeError, RuntimeError, OSError)


class AudioManager:
    def __init__(
        self, config: AudioConfig, socket_path: Path, status_path: Path
    ) -> None:
        self.config = config
        self.status_path = status_path
        self.running = True
        # The output sink stays pinned at full scale; loudness lives on the two
        # bus gains instead, so music and voice are truly independent. Both
        # levels are seeded from configuration each daemon start; the controller
        # owns them through the control socket and re-asserts its own cached
        # values after either process restarts, like the routes.
        self.music_volume = config.startup_volume_percent
        self.voice_volume = config.voice_bus.volume_percent
        self.usb_host = False
        self.usb_playback = False
        self.output_muted = False

        self.graph = Graph()
        self.modules = ModuleRegistry(self.graph)
        self.background = BackgroundBus(config.background, self.graph, self.modules)
        self.voice_bus = VoiceBus(config.voice_bus, self.graph, self.modules)
        self.voice_capture = VoiceCapture(
            config.voice_capture_channel, self.graph, self.modules
        )
        self.aec_reference = AecReference(
            config.aec_reference, self.graph, self.modules
        )
        self.routes = SourceRoutes(config.sources, self.graph, self.modules)
        self.usb_volume = UsbVolumeSync()

        self.selector = selectors.DefaultSelector()
        self.commands = CommandHandler(self)
        self.control = ControlServer(
            socket_path, self.selector, self.commands, self._reconcile_and_broadcast
        )
        self.graph_events = monitors.graph_events(
            self.selector, self.schedule_reconcile, self._subscribe_restarted
        )
        self.mixer_events = monitors.gadget_mixer_events(
            self.selector, self.schedule_reconcile
        )

        self.pending_reconcile: float | None = None
        self.next_resync = 0.0
        self.next_usb_poll = 0.0
        self._last_broadcast = self._broadcast_signature()

    def stop(self, *_args: object) -> None:
        self.running = False

    def execute(self) -> int:
        self.wait_for_pulse()
        self.control.start()
        self.graph_events.start()
        self.safe_reconcile()
        while self.running:
            self._wait_for_work()
            self.graph_events.tick()
            self.mixer_events.tick()
            self._poll_usb_host()
            self._reconcile_when_due()
            # Every reconcile refreshes the playback state, and a USB host can
            # move the music level, whichever signal scheduled it; broadcast a
            # change so the controller's icon and readout update without
            # waiting for a command.
            self._broadcast_changes()
        self.graph_events.stop()
        self.mixer_events.stop()
        self.control.close()
        self.selector.close()
        for role in reversed(self.modules.roles()):
            self._guard(
                f"Releasing {role}",
                lambda role=role: self.modules.unload(role),
            )
        return 0

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
            "usb_playback": self.usb_playback,
            "music_volume": self.music_volume,
            "voice_volume": self.voice_volume,
            "output_muted": self.output_muted,
        }

    def desired_ducking(self) -> bool:
        return self.config.background.enabled and self.commands.duck_requested

    def apply_ducking(self) -> bool:
        ducked = self.desired_ducking()
        self.background.apply_ducking(self.music_volume, ducked)
        return ducked

    def safe_apply_ducking(self) -> None:
        self._apply_or_retry("Audio ducking", self.apply_ducking)

    def set_voice_volume(self, percent: float) -> None:
        self.voice_volume = volume.clamp(percent)
        self._apply_or_retry(
            "Voice volume", lambda: self.voice_bus.apply_gain(self.voice_volume)
        )

    def set_output_mute(self, muted: bool) -> None:
        self.output_muted = muted
        self._apply_or_retry("Output mute", self._apply_output_mute)

    def set_music_volume(self, percent: float) -> None:
        self.music_volume = volume.clamp(percent)
        # Forget the last USB agreement so the next reconcile seeds the gadget
        # with this commanded level; otherwise the gadget's stale reading would
        # win the sync and claw the volume back.
        self.usb_volume.forget()
        self._apply_or_retry("Music volume", self._apply_music_volume)

    def schedule_reconcile(self, delay: float = EVENT_DEBOUNCE_SECONDS) -> None:
        if self.pending_reconcile is None:
            self.pending_reconcile = time.monotonic() + delay

    def safe_reconcile(self) -> bool:
        succeeded = self._guard("Audio reconciliation", self.reconcile)
        self.pending_reconcile = None
        delay = (
            self.config.resync_seconds if succeeded else RECONCILE_RETRY_SECONDS
        )
        self.next_resync = time.monotonic() + delay
        return succeeded

    def reconcile(self) -> None:
        self.graph.invalidate()
        self.modules.drop_released()
        sink = self.graph.find_sink(self.config.output_match)
        output.pin_volume(sink)
        # A mute made by any other client rides in on the same subscribe event
        # that scheduled this pass, so the controller never has to poll for it.
        muted = output.mute_state(sink)
        if muted is not None:
            self.output_muted = muted
        # A host volume change may move the music level, so sync before the bus
        # and route gains below are applied against it.
        self.music_volume = self.usb_volume.sync(sink, self.music_volume)
        background_sink = self.background.reconcile(sink)
        voice_sink = self.voice_bus.reconcile(sink)
        self.voice_bus.apply_gain(self.voice_volume)
        # The remap source's properties name its master device, so it would
        # match voice_input_match itself; exclude it or it becomes its own
        # master on the next reconcile.
        voice_device = self.graph.find_source(
            self.config.voice_input_match, excluding=voice_capture.SOURCE_NAME
        )
        voice_source, capture_status = self.voice_capture.reconcile(voice_device)
        ducked = self.apply_ducking()
        self._adopt_defaults(sink, voice_source)
        aec_status = self.aec_reference.reconcile(sink)
        self.usb_host = usb_gadget.host_attached()
        self.usb_playback = self.usb_host and usb_gadget.streaming()
        source_status = self.routes.reconcile(
            output=sink,
            background_sink=background_sink,
            music_volume=self.music_volume,
            usb_playback=self.usb_playback,
        )
        output.hold_client_streams(self.graph, sink, self.music_volume)
        # Sendspin plays into the bus as an ordinary Pulse client; the bridge
        # carries the music level, so its stream holds only the input's trim.
        output.hold_client_streams(
            self.graph, background_sink, self.config.background.client_volume_percent
        )
        published = {
            "sink": sink.get("name") if sink else None,
            "music_volume": self.music_volume,
            "voice_input": voice_device.get("name") if voice_device else None,
            "voice_capture": capture_status,
            "background": {
                "available": self.background.available,
                "sink": background_sink.get("name") if background_sink else None,
                "ducked": ducked,
            },
            "voice_bus": {
                "enabled": self.config.voice_bus.enabled,
                "available": self.voice_bus.available,
                "sink": voice_sink.get("name") if voice_sink else None,
                "volume_percent": self.voice_volume,
            },
            "aec_reference": aec_status,
            "sources": source_status,
            "usb_host": self.usb_host,
            "usb_playback": self.usb_playback,
            "output_muted": self.output_muted,
        }
        status.write(self.status_path, published)
        LOG.debug("reconciled: %s", json.dumps(published))

    def broadcast_state(self) -> None:
        self._last_broadcast = self._broadcast_signature()
        self.control.broadcast(self.state_event())

    def _broadcast_signature(self) -> tuple[object, ...]:
        return (self.usb_playback, self.music_volume, self.output_muted)

    def _apply_output_mute(self) -> None:
        self.graph.invalidate()
        output.set_mute(self.graph.find_sink(self.config.output_match), self.output_muted)

    def _apply_music_volume(self) -> None:
        self.graph.invalidate()
        self.apply_ducking()
        self.routes.apply_music_volume(self.music_volume)

    def _adopt_defaults(self, sink: Node | None, voice_source: Node | None) -> None:
        # Only set defaults that are wrong: an unconditional set-default emits a
        # subscribe event on every reconcile, which would echo into another
        # scheduled reconcile and never quiesce.
        if sink and pactl.default_sink() != sink["name"]:
            pactl.set_default_sink(sink["name"])
        if voice_source and pactl.default_source() != voice_source["name"]:
            pactl.set_default_source(voice_source["name"])

    def _wait_for_work(self) -> None:
        # Ducking is applied when a set-duck arrives, when a client holding a
        # request disconnects, and at the end of every reconcile, so the loop
        # needs no poll interval to notice a duck request.
        deadline = min(
            self.next_resync,
            self.next_usb_poll,
            self.pending_reconcile
            if self.pending_reconcile is not None
            else self.next_resync,
        )
        for key, _ in self.selector.select(max(0.0, deadline - time.monotonic())):
            key.data()

    def _poll_usb_host(self) -> None:
        now = time.monotonic()
        if now < self.next_usb_poll:
            return
        self.next_usb_poll = now + USB_HOST_POLL_SECONDS
        attached = usb_gadget.host_attached()
        playing = attached and usb_gadget.streaming()
        if (attached, playing) == (self.usb_host, self.usb_playback):
            return
        LOG.info(
            "USB host %s, playback %s",
            "attached" if attached else "detached",
            "streaming" if playing else "stopped",
        )
        # Reconcile builds or tears down the gated USB route and records the
        # new state.
        self.safe_reconcile()

    def _reconcile_when_due(self) -> None:
        now = time.monotonic()
        if now >= self.next_resync or (
            self.pending_reconcile is not None and now >= self.pending_reconcile
        ):
            self.safe_reconcile()

    def _broadcast_changes(self) -> None:
        if self._broadcast_signature() != self._last_broadcast:
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
