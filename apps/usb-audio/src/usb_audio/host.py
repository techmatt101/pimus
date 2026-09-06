"""Whether a computer is plugged into the audio gadget, and whether it plays."""

from __future__ import annotations

import logging

from . import gadget as usb_gadget


LOG = logging.getLogger(__name__)

class UsbHost:
    """The gadget's enumeration and streaming state, read as one pair.

    Streaming is only meaningful while a host is enumerated, and the route
    gate and the published status both want answers
    from the same instant, so they are never read apart.
    """

    def __init__(self) -> None:
        self.attached = False
        self.streaming = False

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
