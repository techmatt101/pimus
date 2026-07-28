"""Child processes whose output lines tell the daemon the graph may have moved."""

from __future__ import annotations

import logging
import os
import re
import selectors
import subprocess
import time
from typing import Callable

from . import process, usb_gadget


LOG = logging.getLogger(__name__)

# Facilities whose subscribe events can invalidate the reconciled graph.
# `client` is deliberately excluded: every pactl invocation this process makes
# emits client events, which would schedule reconciles forever.
RELEVANT_FACILITIES = frozenset(
    {"sink", "source", "sink-input", "module", "server", "card"}
)


def is_relevant_event(line: str) -> bool:
    match = re.match(r"Event '[\w-]+' on ([\w-]+)", line)
    return match is not None and match.group(1) in RELEVANT_FACILITIES


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
) -> LineMonitor:
    def relevant(line: bytes) -> None:
        if is_relevant_event(line.decode("utf-8", "replace")):
            schedule_reconcile()

    return LineMonitor(
        "pactl subscribe",
        ["pactl", "subscribe"],
        selector=selector,
        retry_seconds=1.0,
        on_line=relevant,
        on_restart=on_restart,
    )


def gadget_mixer_events(
    selector: selectors.BaseSelector, schedule_reconcile: Callable[[], None]
) -> LineMonitor:
    # The USB host's volume writes and its stream opens and closes change only
    # ALSA controls on the gadget card, which pactl subscribe cannot see;
    # alsactl monitor is the ALSA equivalent, one line per control event. The
    # kernel notifies "Capture Rate" as the host starts or stops streaming,
    # which is what makes the USB route react faster than the fallback poll.
    def capture_control(line: bytes) -> None:
        if b"Capture" in line:
            schedule_reconcile()

    return LineMonitor(
        "alsactl monitor",
        ["alsactl", "monitor", f"hw:{usb_gadget.CARD}"],
        selector=selector,
        retry_seconds=5.0,
        on_line=capture_control,
        can_start=usb_gadget.card_present,
        quiet_stderr=True,
    )
