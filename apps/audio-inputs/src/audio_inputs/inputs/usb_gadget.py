"""The UAC2 gadget a computer plugs into: gated on its stream, volume agreed."""

from __future__ import annotations

import logging
import selectors
from typing import Any, Callable

from smartamp_audio.graph import Node
from smartamp_audio.monitors import LineMonitor
from . import gadget
from .input import Input
from .usb_volume import UsbVolumeSync


LOG = logging.getLogger(__name__)


class UsbGadgetInput(Input):
    """With no host streaming the gadget's capture clock never ticks, and a
    loopback linked to it would stall the whole output graph: the loopback
    runs only while the host holds its stream open, whatever the manager's
    toggle says - that is a mute the manager applies, not a reason to stop
    the clock. The host's volume slider is kept agreed with the music bus's
    own volume register, exactly as any player's is."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.attached = False
        self.streaming = False
        self._volume = UsbVolumeSync()

    def watch(
        self, selector: selectors.BaseSelector, schedule: Callable[[], None]
    ) -> list[LineMonitor]:
        # The USB host's volume writes and its stream opens and closes change
        # only ALSA controls on the gadget card, which pactl subscribe cannot
        # see; alsactl monitor is the ALSA equivalent, one line per control
        # event. The kernel notifies "Capture Rate" as the host starts or
        # stops streaming, which is what makes the input react faster than
        # the fallback poll.
        def capture_control(line: bytes) -> None:
            if b"Capture" in line:
                schedule()

        return [
            LineMonitor(
                "alsactl monitor",
                ["alsactl", "monitor", f"hw:{gadget.CARD}"],
                selector=selector,
                retry_seconds=5.0,
                on_line=capture_control,
                can_start=gadget.card_present,
                quiet_stderr=True,
            )
        ]

    def reconcile(self, bus: Node | None, awake: bool) -> None:
        self._refresh_host()
        # Stop a dead capture clock before graph queries: leaving it linked
        # can stall the driver's other playback streams.
        if not self.streaming:
            self._loopback.stop()
        source = self._find_device(activate=True)
        self._volume.sync(bus if self.attached else None, self._graph)
        self._play(source, bus, wanted=self.streaming)

    def status(self) -> dict[str, Any]:
        return {
            "host": self.attached,
            "streaming": self.streaming,
            **super().status(),
        }

    def _refresh_host(self) -> None:
        # Streaming is only meaningful while a host is enumerated, and the
        # gate and the status both want answers from the same instant.
        attached = gadget.host_attached()
        streaming = attached and gadget.streaming()
        if (attached, streaming) == (self.attached, self.streaming):
            return
        self.attached = attached
        self.streaming = streaming
        LOG.info(
            "USB host %s, playback %s",
            "attached" if attached else "detached",
            "streaming" if streaming else "stopped",
        )
