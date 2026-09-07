"""Percent handling shared by the audio apps."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

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
