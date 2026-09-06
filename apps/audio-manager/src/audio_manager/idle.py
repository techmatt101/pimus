"""Deciding when playback is quiet enough to release the persistent bridges.

Every bridge this daemon keeps loaded holds an ALSA device running: the bus
bridges and the muted aux route keep the HiFiBerry path clocked, and the AEC
reference keeps the microphone's playback endpoint awake. With nothing playing that
is roughly a watt spent on silence, so after a quiet spell the bridges are
unloaded and the devices suspend; the next client stream, voice session, or
route toggle rebuilds them within a second. The null sinks stay loaded so the
clients pointed at them by PULSE_SINK never lose their target, and the voice
capture path is untouched because the wake word must keep hearing.
"""

from __future__ import annotations

import logging
import time
from typing import Callable

from smartamp_audio.graph import Node, media_name
from .modules import STREAM_PREFIX


LOG = logging.getLogger(__name__)


def playing_clients(sink_inputs: list[Node], owned_module_ids: set[str]) -> bool:
    """Whether any stream this daemon does not own is actually playing.

    The daemon's own loopback streams must not count, or the bridges would
    hold themselves awake forever; a corked stream is a client that kept its
    connection open without playing, which is silence too.
    """
    return any(
        not stream.get("corked", False)
        and str(stream.get("owner_module")) not in owned_module_ids
        and not media_name(stream).startswith(STREAM_PREFIX)
        for stream in sink_inputs
    )


class IdleTracker:
    """The applied idle state and the instant the graph earns it."""

    def __init__(
        self, timeout_seconds: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.idle = False
        self._clock = clock
        self._last_active = clock()

    @property
    def enabled(self) -> bool:
        return self.timeout_seconds > 0

    def update(self, active: bool) -> bool:
        """Record this reconcile's activity; returns whether to be torn down.

        Derived, not latched: a touch() moving the activity instant forward is
        enough to clear an applied idle on the next pass, which is how a voice
        session opening rebuilds before any stream exists, and an expire()
        moving it back is enough to apply one.
        """
        now = self._clock()
        if active:
            self._last_active = now
        was_idle = self.idle
        quiet_seconds = now - self._last_active
        self.idle = (
            self.enabled and not active and quiet_seconds >= self.timeout_seconds
        )
        if was_idle and not self.idle:
            LOG.info("Rebuilding the idle bridges")
        elif self.idle and not was_idle:
            LOG.info("No playback for %.0fs; releasing the idle bridges", quiet_seconds)
        return self.idle

    def touch(self) -> None:
        """An early hint of activity (a voice session opening) before any
        stream exists, so the rebuild starts ahead of the first audio."""
        self._last_active = self._clock()

    def expire(self) -> None:
        """Deem the quiet spell served, so the next pass releases the bridges
        if nothing is playing. Anything still playing resets the instant and
        the request is forgotten rather than held: it is a way to see the idle
        state without waiting for it, not a second reason to be idle."""
        self._last_active = self._clock() - self.timeout_seconds

    def deadline(self) -> float | None:
        """When the bridges fall due for release, if they still are loaded."""
        if not self.enabled or self.idle:
            return None
        return self._last_active + self.timeout_seconds
