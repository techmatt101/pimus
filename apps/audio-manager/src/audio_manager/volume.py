"""Percent handling and the fades that keep a level change inaudible."""

from __future__ import annotations

import time
from typing import Any

from . import pactl


def clamp(percent: Any) -> int:
    return max(0, min(100, round(float(percent))))


def is_percent(value: Any) -> bool:
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
