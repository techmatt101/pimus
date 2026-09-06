"""ALSA mixer events belong to the USB client."""

import selectors
from typing import Callable
from smartamp_audio.monitors import LineMonitor
from . import gadget as usb_gadget

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
