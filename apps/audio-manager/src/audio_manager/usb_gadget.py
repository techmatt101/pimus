"""The UAC2 USB audio gadget: whether a host is there, and its mixer."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from . import process


# The gadget kernel driver hardcodes its ALSA card id. A USB host's volume and
# mute changes land on this card's "PCM Capture" mixer controls, and writing
# them from this side sends the host a UAC2 interrupt so its slider follows.
CARD = "UAC2Gadget"


def host_attached(base: Path = Path("/sys/class/udc")) -> bool:
    # The UDC state file reads "configured" once a USB host has enumerated the
    # gadget. It is not a reliable disconnect signal: with the recommended
    # VBUS-blocking adapter the port never sees the session drop, so the file
    # stays "configured" after an unplug. Kept for the status file only; the
    # route gate and the controller's icon follow streaming().
    try:
        for state_file in base.glob("*/state"):
            if state_file.read_text(encoding="utf-8").strip() == "configured":
                return True
    except OSError:
        pass
    return False


def card_present(base: Path = Path("/proc/asound")) -> bool:
    return (base / CARD).exists()


def streaming() -> bool:
    """True while the USB host is actively streaming audio into the gadget.

    The kernel's UAC2 function reports the host's playback stream through the
    gadget card's read-only "Capture Rate" control: the negotiated rate while
    the host holds the stream open, 0 once it closes it or the bus suspends.
    An unplug reads 0 through the suspend path too, which makes this the only
    signal that survives the VBUS-blocked port never reporting a disconnect.
    """
    try:
        result = process.run(
            "amixer",
            "-c",
            CARD,
            "cget",
            "iface=PCM,name=Capture Rate",
            check=False,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    if result.returncode != 0:
        return False
    match = re.search(r": values=(\d+)", result.stdout)
    return match is not None and int(match.group(1)) > 0


def read_mixer() -> tuple[int, bool] | None:
    """The gadget card's (volume percent, muted) as the USB host last set it."""
    result = process.run("amixer", "-c", CARD, "-M", "sget", "PCM", check=False)
    if result.returncode != 0:
        return None
    volume = re.search(r"\[(\d+)%\]", result.stdout)
    switch = re.search(r"\[(on|off)\]", result.stdout)
    if volume is None or switch is None:
        return None
    return int(volume.group(1)), switch.group(1) == "off"


def write_mixer(percent: int, muted: bool) -> None:
    process.run(
        "amixer",
        "-c",
        CARD,
        "-M",
        "sset",
        "PCM",
        f"{percent}%",
        "nocap" if muted else "cap",
    )


def volumes_match(a: tuple[int, bool], b: tuple[int, bool]) -> bool:
    # The gadget control quantises to its UAC2 volume resolution, so a value
    # can come back one percent off what was written; treating that as equal
    # is what stops the two sides nudging each other forever.
    return abs(a[0] - b[0]) <= 1 and a[1] == b[1]
