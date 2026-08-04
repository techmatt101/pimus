"""Whether a computer is plugged into the audio gadget, and whether it plays."""

from __future__ import annotations

import logging
import time
from typing import Callable

from ..system import usb_gadget


LOG = logging.getLogger(__name__)

# Plugging or unplugging the USB-C gadget cable, or the host opening or closing
# its playback stream, changes no PipeWire state, so pactl subscribe never
# reports it. The gadget's mixer monitor usually announces a stream open/close
# instantly; this poll is the fallback that also catches events raced while
# that monitor was restarting.
POLL_SECONDS = 2.0


class UsbHost:
    """The gadget's enumeration and streaming state, read as one pair.

    Streaming is only meaningful while a host is enumerated, and the route
    gate, the idle judgement and the published status all want both answers
    from the same instant, so they are never read apart.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.attached = False
        self.streaming = False
        self._clock = clock
        self._next_poll = 0.0

    def deadline(self) -> float:
        """When the fallback poll falls due."""
        return self._next_poll

    def refresh(self) -> bool:
        """Re-read the gadget; returns whether either answer changed."""
        attached = usb_gadget.host_attached()
        streaming = attached and usb_gadget.streaming()
        if (attached, streaming) == (self.attached, self.streaming):
            return False
        self.attached = attached
        self.streaming = streaming
        LOG.info(
            "USB host %s, playback %s",
            "attached" if attached else "detached",
            "streaming" if streaming else "stopped",
        )
        return True

    def poll(self) -> bool:
        """Re-read once the fallback interval is up; returns whether it changed.

        The interval is only advanced by the poll itself, so a refresh taken
        during a reconcile leaves the fallback on its own cadence.
        """
        now = self._clock()
        if now < self._next_poll:
            return False
        self._next_poll = now + POLL_SECONDS
        return self.refresh()
