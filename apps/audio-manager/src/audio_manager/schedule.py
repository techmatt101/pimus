"""When the next reconcile pass runs: an event's booking, and the resync behind it."""

from __future__ import annotations

# A burst of pactl subscribe events (device hotplug, PipeWire restart) settles
# into one reconcile scheduled this far ahead of the first event.
EVENT_DEBOUNCE_SECONDS = 0.3

# A transient graph race should heal promptly rather than waiting for the
# normal fifteen-minute safety resync.
RETRY_SECONDS = 1.0


class ReconcileSchedule:
    """Two deadlines, and the pass runs at whichever comes first.

    A booking is the earliest of everything asked for since the last pass, so
    an event burst becomes one pass and an immediate request advances a
    debounced one. It is cleared as the pass begins rather than as it ends, so
    a pass that finds a bridge unsettled can book its own follow-up. Behind it
    the resync is always set: the long safety interval after a pass that
    succeeded, a short retry after one that failed.
    """

    def __init__(self, resync_seconds: float) -> None:
        self._resync_seconds = resync_seconds
        self.booked: float | None = None
        self.resync = 0.0

    def book(self, now: float, delay: float = EVENT_DEBOUNCE_SECONDS) -> None:
        deadline = now + delay
        if self.booked is None or deadline < self.booked:
            self.booked = deadline

    def retry(self, now: float) -> None:
        self.book(now, RETRY_SECONDS)

    def begin(self) -> None:
        self.booked = None

    def settle(self, now: float, succeeded: bool) -> None:
        self.resync = now + (self._resync_seconds if succeeded else RETRY_SECONDS)

    def deadline(self) -> float:
        return self.resync if self.booked is None else min(self.resync, self.booked)

    def due(self, now: float) -> bool:
        return now >= self.deadline()
