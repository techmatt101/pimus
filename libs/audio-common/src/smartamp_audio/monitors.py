"""Child processes whose output lines tell the daemon the graph may have moved."""

from __future__ import annotations

import logging
import os
import re
import selectors
import subprocess
import time
from typing import Callable

from smartamp_audio import process


LOG = logging.getLogger(__name__)

# Facilities whose subscribe events can invalidate the reconciled graph.
# `client` is deliberately excluded: every pactl invocation this process makes
# emits client events, which would schedule reconciles forever.
RELEVANT_FACILITIES = frozenset(
    {"sink", "source", "sink-input", "module", "server", "card"}
)

_EVENT = re.compile(r"Event '([\w-]+)' on ([\w-]+)")


def is_relevant_event(line: str) -> bool:
    match = _EVENT.match(line)
    return match is not None and match.group(2) in RELEVANT_FACILITIES


def is_stream_change(line: str) -> bool:
    """A stream's own properties moving: its volume, mute, or name, never
    a stream appearing or leaving."""
    match = _EVENT.match(line)
    return match is not None and match.groups() == ("change", "sink-input")


class LineMonitor:
    """A long-running child read line by line, restarted when it dies."""

    def __init__(
        self,
        description: str,
        command: list[str],
        *,
        selector: selectors.BaseSelector,
        retry_seconds: float,
        on_line: Callable[[bytes], None],
        can_start: Callable[[], bool] | None = None,
        on_restart: Callable[[], None] | None = None,
        quiet_stderr: bool = False,
    ) -> None:
        self.description = description
        self._command = command
        self._selector = selector
        self._retry_seconds = retry_seconds
        self._on_line = on_line
        self._can_start = can_start
        self._on_restart = on_restart
        self._quiet_stderr = quiet_stderr
        self._process: subprocess.Popen[bytes] | None = None
        self._buffer = b""
        self._retry_at = 0.0

    def start(self) -> None:
        try:
            self._process = process.spawn(
                self._command, quiet_stderr=self._quiet_stderr
            )
        except OSError as error:
            LOG.warning("%s failed to start: %s", self.description, error)
            self._process = None
            self._defer_retry()
            return
        stdout = self._process.stdout
        assert stdout is not None
        os.set_blocking(stdout.fileno(), False)
        self._buffer = b""
        self._selector.register(stdout, selectors.EVENT_READ, self._read)

    def stop(self) -> None:
        running = self._process
        if running is None:
            return
        self._process = None
        self._defer_retry()
        if running.stdout is not None:
            try:
                self._selector.unregister(running.stdout)
            except (KeyError, ValueError):
                pass
            running.stdout.close()
        running.terminate()
        try:
            running.wait(timeout=1)
        except subprocess.TimeoutExpired:
            running.kill()
            running.wait(timeout=1)

    def deadline(self) -> float | None:
        """Wake the owner for a restart even when no graph events arrive."""
        return self._retry_at if self._process is None else None

    def tick(self) -> None:
        """Reap the child if it died, and restart it once the backoff expires."""
        if self._process is not None and self._process.poll() is not None:
            self.stop()
        if self._process is not None or time.monotonic() < self._retry_at:
            return
        if self._can_start is not None and not self._can_start():
            return
        self.start()
        if self._on_restart is not None:
            self._on_restart()

    def _read(self) -> None:
        running = self._process
        if running is None or running.stdout is None:
            return
        try:
            data = os.read(running.stdout.fileno(), 4096)
        except (BlockingIOError, OSError):
            return
        if not data:
            self.stop()
            return
        self._buffer += data
        while b"\n" in self._buffer:
            line, _, self._buffer = self._buffer.partition(b"\n")
            self._on_line(line)

    def _defer_retry(self) -> None:
        self._retry_at = time.monotonic() + self._retry_seconds


def graph_events(
    selector: selectors.BaseSelector,
    schedule_reconcile: Callable[[], None],
    on_restart: Callable[[], None],
    *,
    stream_changes: bool = True,
) -> LineMonitor:
    """The subscribe feed, filtered to what can move the reconciled graph.
    A daemon that holds no stream level passes `stream_changes=False` and
    is left alone while another one moves them. Owners coalesce notifications
    with a bounded reconcile deadline; a change can also mean playback resumed,
    so even an event immediately following our own volume write must arrive."""

    def relevant(line: bytes) -> None:
        text = line.decode("utf-8", "replace")
        if not is_relevant_event(text):
            return
        if not stream_changes and is_stream_change(text):
            return
        schedule_reconcile()

    return LineMonitor(
        "pactl subscribe",
        ["pactl", "subscribe"],
        selector=selector,
        retry_seconds=1.0,
        on_line=relevant,
        on_restart=on_restart,
    )
