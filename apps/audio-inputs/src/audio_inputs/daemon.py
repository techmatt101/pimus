"""The reconcile loop: every input looked at together, on the same graph."""

from __future__ import annotations

import json
import logging
import selectors
import subprocess
import time
from pathlib import Path
from typing import Any, cast

from smartamp_audio import monitors, status
from smartamp_audio.graph import Graph
from .config import InputsConfig
from .inputs import create


LOG = logging.getLogger(__name__)

IO_ERRORS = (OSError, subprocess.SubprocessError, RuntimeError, ValueError)

# A host can start or stop streaming, and the manager can go idle, without an
# event this daemon sees; look at least this often regardless.
FALLBACK_SECONDS = 2.0
RETRY_SECONDS = 1.0


class AudioInputs:
    def __init__(self, config: InputsConfig, status_path: Path) -> None:
        self.config = config
        self.status_path = status_path
        self.running = True
        self.graph = Graph()
        self.selector = selectors.DefaultSelector()
        self.inputs = {
            name: create(name, entry, self.graph) for name, entry in config.inputs.items()
        }
        self.graph_events = monitors.graph_events(
            self.selector, self.schedule, self.schedule
        )
        self.monitors = [
            monitor
            for entry in self.inputs.values()
            for monitor in entry.watch(self.selector, self.schedule)
        ]
        self._next_reconcile = 0.0

    def stop(self, *_: object) -> None:
        self.running = False

    def schedule(self) -> None:
        self._next_reconcile = 0.0

    def execute(self) -> int:
        try:
            self.status_path.unlink(missing_ok=True)
            while self.running:
                # Tick even without events to reap helpers and restart monitors.
                if time.monotonic() >= self._next_reconcile:
                    self.safe_reconcile()
                self.graph_events.tick()
                for monitor in self.monitors:
                    monitor.tick()
                timeout = max(0.0, min(1.0, self._next_reconcile - time.monotonic()))
                for key, _ in self.selector.select(timeout):
                    key.data()
            return 0
        finally:
            self._close()

    def state(self) -> dict[str, Any]:
        return {"inputs": {name: entry.status() for name, entry in self.inputs.items()}}

    def safe_reconcile(self) -> None:
        self._next_reconcile = time.monotonic() + FALLBACK_SECONDS
        try:
            self.reconcile()
            status.write(self.status_path, self.state())
        except IO_ERRORS:
            LOG.exception("Input reconciliation failed")
            for entry in self.inputs.values():
                entry.stop()
            self.status_path.unlink(missing_ok=True)
            self._next_reconcile = time.monotonic() + RETRY_SECONDS

    def reconcile(self) -> None:
        self.graph.invalidate()
        published, awake = self._manager_state()
        bus = self.graph.sink_named(self.config.sink_name) if published else None
        delay = FALLBACK_SECONDS
        for entry in self.inputs.values():
            entry.reconcile(bus, awake)
            retry = entry.retry_seconds
            if retry is not None:
                delay = min(delay, retry)
        self._next_reconcile = time.monotonic() + delay

    def _manager_state(self) -> tuple[bool, bool]:
        """Whether the manager has published the bus, and whether it is
        keeping the graph awake. Until a fresh manager has seeded the bus
        nothing may play into it; an idle bus is valid, and only the inputs
        that would hold a device clocked for nothing stay off it."""
        try:
            document = json.loads(self.config.audio_status.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False, False
        if not isinstance(document, dict):
            return False, False
        status_document = cast(dict[str, Any], document)
        music_bus = status_document.get("music_bus")
        published = (
            isinstance(music_bus, dict)
            and cast(dict[str, Any], music_bus).get("sink") == self.config.sink_name
        )
        return published, not bool(status_document.get("idle", False))

    def _close(self) -> None:
        for description, close in (
            *((f"Stopping {name} input", entry.stop) for name, entry in self.inputs.items()),
            ("Stopping graph events", self.graph_events.stop),
            *(("Stopping monitor", monitor.stop) for monitor in self.monitors),
            ("Closing selector", self.selector.close),
            ("Withdrawing status", lambda: self.status_path.unlink(missing_ok=True)),
        ):
            try:
                close()
            except IO_ERRORS:
                LOG.exception("%s failed", description)
