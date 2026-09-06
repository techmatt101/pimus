"""Percent handling and the fades that keep a level change inaudible."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from smartamp_audio import pactl


if TYPE_CHECKING:
    # The control computer's Python may predate 3.10; the Pi's does not.
    from typing import TypeGuard


def clamp(percent: Any) -> int:
    return max(0, min(100, round(float(percent))))


def scale(level: int, percent: int) -> int:
    """The share of a level a percent selects: scale(60, 50) is 30."""
    return round(level * percent / 100)


def is_percent(value: Any) -> TypeGuard[float]:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and 0 <= value <= 100
    )


def fade_stream(stream_index: int, start: int, target: int, fade_ms: int) -> None:
    steps = 1 if start == target else max(1, min(10, fade_ms // 50))
    delay = fade_ms / steps / 1000 if fade_ms else 0
    for step in range(1, steps + 1):
        pactl.set_sink_input_volume(
            stream_index, round(start + (target - start) * step / steps)
        )
        if delay and step < steps:
            time.sleep(delay)
