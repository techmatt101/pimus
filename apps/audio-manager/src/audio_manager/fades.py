"""Control-rate gain ramps advanced by the manager's selector deadlines."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from smartamp_audio import pactl


STEP_SECONDS = 0.05


@dataclass
class Fade:
    start: int
    target: int
    current: int
    started: float
    duration: float
    due: float
    applied: Callable[[int | None], None]


class Fades:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._pending: dict[int, Fade] = {}

    def target(self, index: int) -> int | None:
        fade = self._pending.get(index)
        return fade.target if fade is not None else None

    def cancel(self, index: int) -> None:
        self._pending.pop(index, None)

    def clear(self) -> None:
        self._pending.clear()

    def set(
        self, index: int, start: int, target: int, milliseconds: int,
        applied: Callable[[int | None], None],
    ) -> None:
        previous = self._pending.pop(index, None)
        if previous is not None:
            start = previous.current
        if milliseconds <= 0 or start == target:
            applied(None)
            pactl.set_sink_input_volume(index, target)
            applied(target)
            return
        now = self._clock()
        duration = milliseconds / 1000
        self._pending[index] = Fade(
            start, target, start, now, duration,
            now + min(STEP_SECONDS, duration), applied,
        )
        applied(start)

    def deadline(self) -> float | None:
        return min((fade.due for fade in self._pending.values()), default=None)

    def tick(self) -> None:
        for index, fade in list(self._pending.items()):
            now = self._clock()
            if now < fade.due:
                continue
            end = fade.started + fade.duration
            fraction = 1.0 if now >= end else (now - fade.started) / fade.duration
            level = round(fade.start + (fade.target - fade.start) * fraction)
            if level != fade.current:
                # Remove it before I/O: a failed write must never leave an old
                # ramp retrying over the reconciliation that repairs the gain.
                self._pending.pop(index)
                fade.applied(None)
                pactl.set_sink_input_volume(index, level)
                fade.applied(level)
                fade.current = level
            if fraction >= 1.0:
                self._pending.pop(index, None)
            else:
                fade.due = min(now + STEP_SECONDS, end)
                self._pending[index] = fade
