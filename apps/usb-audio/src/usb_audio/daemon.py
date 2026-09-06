"""USB host lifecycle and playback; shared audio policy lives elsewhere."""
from __future__ import annotations

import json
import logging
import selectors
import shlex
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, cast
from smartamp_audio import monitors, pactl, status, volume
from smartamp_audio.graph import Graph, profiles_of
from smartamp_audio.server import ControlServer
from .config import UsbConfig
from .host import UsbHost
from .monitors import gadget_mixer_events
from .playback import Playback
from .volume_sync import UsbVolumeSync

LOG = logging.getLogger(__name__)
IO_ERRORS = (OSError, subprocess.SubprocessError, RuntimeError, ValueError)


class UsbAudio:
    def __init__(self, config: UsbConfig, socket_path: Path, status_path: Path) -> None:
        self.config = config
        self.status_path = status_path
        self.enabled = config.enabled
        self.trim = config.volume_percent
        self.running = True
        self.available = False
        self.source_name: str | None = None
        self.graph = Graph()
        self.host = UsbHost()
        self.volume_sync = UsbVolumeSync()
        self.playback = Playback(self.graph, config.latency_ms)
        self.selector = selectors.DefaultSelector()
        self.control = ControlServer(socket_path, self.selector, self, self.safe_reconcile)
        self.graph_events = monitors.graph_events(self.selector, self.schedule, self.schedule)
        self.mixer_events = gadget_mixer_events(self.selector, self.schedule)
        self._legacy_released = False
        self._next_reconcile = 0.0
        self._last_state: dict[str, Any] | None = None

    def stop(self, *_: object) -> None:
        self.running = False

    def schedule(self) -> None:
        self._next_reconcile = 0.0

    def execute(self) -> int:
        try:
            self.status_path.unlink(missing_ok=True)
            self.control.start()
            while self.running:
                # Tick even without events to reap helpers and restart monitors.
                if time.monotonic() >= self._next_reconcile:
                    self.safe_reconcile()
                self.graph_events.tick()
                self.mixer_events.tick()
                timeout = max(0.0, min(1.0, self._next_reconcile - time.monotonic()))
                for key, _ in self.selector.select(timeout):
                    key.data()
            return 0
        finally:
            for close in (self.playback.stop, self.graph_events.stop,
                          self.mixer_events.stop, self.control.close, self.selector.close,
                          lambda: self.status_path.unlink(missing_ok=True)):
                try:
                    close()
                except IO_ERRORS:
                    LOG.exception("USB cleanup failed")

    def state_event(self) -> dict[str, Any]:
        # The one USB source, in the shape the audio manager lists its own:
        # its trim, its toggle, and the capture node it plays from.
        return {
            "event": "state",
            "sources": {"usb": {
                "trim": self.trim, "enabled": self.enabled,
                "available": self.available, "node": self.source_name,
            }},
            "usb_host": self.host.attached, "usb_playback": self.host.streaming,
            "playing": self.playback.ready,
        }

    def safe_reconcile(self) -> None:
        self._next_reconcile = time.monotonic() + 2.0
        try:
            self.reconcile()
            status.write(self.status_path, self.state_event())
        except IO_ERRORS:
            LOG.exception("USB audio reconciliation failed")
            self.available = False
            self.playback.stop()
            self.status_path.unlink(missing_ok=True)
            self._next_reconcile = time.monotonic() + 1.0
        event = self.state_event()
        if event != self._last_state:
            self._last_state = event
            self.control.broadcast(event)

    def reconcile(self) -> None:
        self.host.refresh()
        # Stop a dead capture clock before graph queries: leaving it linked can
        # stall the driver's other playback streams.
        if not self.enabled or not self.host.streaming:
            self.playback.stop()
        if not self._legacy_released:
            # An older manager killed before cleanup may have left its USB
            # server module behind. Retire only that exact owned bridge.
            for module in pactl.list_modules():
                if (module.get("name") == "module-loopback"
                        and "sink_input_properties=media.name=SmartAmp.usb"
                        in shlex.split(str(module.get("argument", "")))):
                    pactl.unload_module(int(module["index"]))
            self._legacy_released = True
        self.graph.invalidate()
        source = self.graph.find_source(self.config.source_match)
        if source is None:
            card = self.graph.find_card(self.config.source_match)
            if card is not None and card.get("active_profile") == "off":
                profiles = profiles_of(card)
                profile = next((name for name in ("pro-audio", *profiles)
                                if name in profiles and name != "off"), None)
                if profile is not None:
                    pactl.set_card_profile(str(card["name"]), profile)
        self.source_name = str(source["name"]) if source is not None else None
        self.available = source is not None and self.host.streaming
        sink = self.graph.sink_named(self.config.sink_name)
        if not self._bus_published():
            sink = None
        self.volume_sync.sync(sink if self.host.attached else None, self.graph)
        if self.enabled and self.available and source is not None and sink is not None:
            self.playback.reconcile(source, sink, self.trim)
            if not self.playback.ready:
                self._next_reconcile = time.monotonic() + self.playback.retry_seconds
        else:
            self.playback.stop()

    def _bus_published(self) -> bool:
        # Wait for the manager to seed the register. An idle bus is valid:
        # the client stream wakes its output bridge through normal graph events.
        try:
            document = json.loads(self.config.audio_status.read_text(encoding="utf-8"))
            if not isinstance(document, dict):
                return False
            music_bus = cast(dict[str, Any], document).get("music_bus")
            return (isinstance(music_bus, dict)
                    and cast(dict[str, Any], music_bus).get("sink") == self.config.sink_name)
        except (OSError, ValueError):
            return False

    def apply(self, connection: socket.socket, message: Any) -> tuple[dict[str, Any], bool]:
        if not isinstance(message, dict):
            return {"event": "error", "error": "expected a command object"}, False
        message = cast(dict[str, Any], message)
        command = message.get("command")
        if command == "get-state":
            return self.state_event(), False
        if command == "set-source-state" and message.get("name") == "usb":
            requested = message.get("state")
            if requested in ("on", "off", "toggle"):
                enabled = not self.enabled if requested == "toggle" else requested == "on"
                changed = self.enabled != enabled
                self.enabled = enabled
                return self.state_event(), changed
        if command == "set-source-trim" and message.get("name") == "usb":
            percent = message.get("percent")
            if volume.is_percent(percent):
                trim = volume.clamp(percent)
                changed = self.trim != trim
                self.trim = trim
                return self.state_event(), changed
        return {"event": "error", "error": "unknown or invalid USB command"}, False

    def client_gone(self, connection: socket.socket) -> None:
        pass
