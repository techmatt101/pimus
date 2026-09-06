"""The ALSA mixer surface: reading a card's hardware playback level."""

from __future__ import annotations

import re
import subprocess

from smartamp_audio import process


# amixer prints one line per channel, each carrying the raw value, the dB
# equivalent, and the percentage this reads:
#   Front Left: Playback 178 [90%] [-6.00dB] [on]
PLAYBACK_PERCENT = re.compile(r"Playback\s+\d+\s+\[(\d+)%\]")


def playback_percent(card: str, control: str) -> int | None:
    """The lowest percentage `control` reads across its playback channels.

    None when the card or control cannot be read at all, which is the honest
    answer for a unit whose mixer is missing rather than a confident 0. The
    lowest of the channels is taken because an even pair is the only healthy
    state: a card answering 90 and 40 is not at 90.
    """
    try:
        result = process.run("amixer", "-c", card, "sget", control, check=False)
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
    levels = [int(match) for match in PLAYBACK_PERCENT.findall(result.stdout)]
    return min(levels) if levels else None
