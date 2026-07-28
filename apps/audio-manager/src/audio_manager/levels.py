"""Metering voice playback, so the ring can pulse in time with what is said.

The voice bus is a null sink of its own, which means its monitor carries the
assistant's speech and nothing else: no music, no timer chime from another
route. Capturing that monitor and reducing it to one level per block is all the
controller needs to drive an LED effect from the audio, and it keeps the sample
data here rather than putting a second audio path in the Node process.
"""

from __future__ import annotations

import array
import logging
import math
import os
import selectors
import subprocess
import sys
import time
from typing import Callable

from . import process


LOG = logging.getLogger(__name__)

# Speech shape, not fidelity: 8 kHz mono resolves every syllable an LED ring can
# show, at a sixth of the samples the graph already carries.
SAMPLE_RATE = 8000
BLOCK_MILLISECONDS = 40
BLOCK_SAMPLES = SAMPLE_RATE * BLOCK_MILLISECONDS // 1000
BLOCK_BYTES = BLOCK_SAMPLES * 2

FULL_SCALE = 32768.0

# Anything below this reads as a pause between words rather than quiet speech;
# it sets where the ring settles back to during a gap.
FLOOR_DECIBELS = -45.0
SILENCE = 1e-6

# Syllables should reach full brightness at once but fall away smoothly, or the
# ring flickers on every consonant.
RELEASE = 0.35

RETRY_SECONDS = 2.0

# A capture started per utterance would miss the first syllable to process
# startup, and a conversation is many utterances; holding it briefly past the
# last one costs one idle stream and starts the next reply already running.
LINGER_SECONDS = 20.0


def block_level(block: bytes) -> float:
    """Reduces one block of little-endian 16-bit mono samples to a 0..1 loudness."""
    samples = array.array("h")
    samples.frombytes(block)
    if not samples:
        return 0.0
    # array uses the machine's byte order, which is the capture's on every board
    # this runs on; the swap is what keeps that an assumption and not a bug.
    if sys.byteorder == "big":
        samples.byteswap()
    mean_square = sum(sample * sample for sample in samples) / len(samples)
    amplitude = math.sqrt(mean_square) / FULL_SCALE
    if amplitude <= SILENCE:
        return 0.0
    decibels = 20 * math.log10(amplitude)
    return max(0.0, min(1.0, 1 - decibels / FLOOR_DECIBELS))


class VoiceLevelMeter:
    """The voice bus monitor, captured on demand and published as a level."""

    def __init__(
        self,
        selector: selectors.BaseSelector,
        on_level: Callable[[float], None],
        *,
        spawn: Callable[[list[str]], subprocess.Popen[bytes]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._selector = selector
        self._on_level = on_level
        self._spawn = spawn or (lambda command: process.spawn(command, quiet_stderr=True))
        self._clock = clock
        self._process: subprocess.Popen[bytes] | None = None
        self._buffer = b""
        self._source: str | None = None
        self._wanted = False
        self._level = 0.0
        self._hold_until = 0.0
        self._retry_at = 0.0

    @property
    def running(self) -> bool:
        return self._process is not None

    def request(self, wanted: bool) -> None:
        self._wanted = wanted
        if not wanted:
            self._hold_until = self._clock() + LINGER_SECONDS
            self._level = 0.0

    def set_source(self, monitor: str | None) -> None:
        """Names the monitor to capture, as the last reconcile found it."""
        if monitor == self._source:
            return
        self._source = monitor
        if self.running:
            self._stop()

    def deadline(self) -> float | None:
        """When tick() must next run, so the daemon can sleep until then."""
        if self.running:
            return None if self._wanted else self._hold_until
        if self._holding() and self._source is not None:
            return self._retry_at
        return None

    def tick(self) -> None:
        """Starts, stops, and reaps the capture to match demand."""
        if self._process is not None and self._process.poll() is not None:
            LOG.info("Voice level capture exited")
            self._stop()
        if self._holding():
            if not self.running and self._source and self._clock() >= self._retry_at:
                self._start()
        elif self.running:
            self._stop()

    def close(self) -> None:
        self._wanted = False
        self._hold_until = 0.0
        self._stop()

    def _holding(self) -> bool:
        return self._wanted or self._clock() < self._hold_until

    def _start(self) -> None:
        if self._source is None:
            return
        command = [
            "parec",
            f"--device={self._source}",
            "--format=s16le",
            f"--rate={SAMPLE_RATE}",
            "--channels=1",
            f"--latency-msec={BLOCK_MILLISECONDS}",
            "--client-name=smartamp-voice-meter",
        ]
        try:
            self._process = self._spawn(command)
        except OSError as error:
            LOG.warning("Voice level capture failed to start: %s", error)
            self._process = None
            self._retry_at = self._clock() + RETRY_SECONDS
            return
        stdout = self._process.stdout
        if stdout is None:
            self._stop()
            return
        os.set_blocking(stdout.fileno(), False)
        self._buffer = b""
        self._level = 0.0
        self._selector.register(stdout, selectors.EVENT_READ, self._read)
        LOG.info("Metering voice playback on %s", self._source)

    def _stop(self) -> None:
        running = self._process
        self._process = None
        self._buffer = b""
        self._level = 0.0
        self._retry_at = self._clock() + RETRY_SECONDS
        if running is None:
            return
        if running.stdout is not None:
            try:
                self._selector.unregister(running.stdout)
            except (KeyError, ValueError):
                pass
            running.stdout.close()
        running.terminate()
        try:
            running.wait(timeout=1)
        except subprocess.TimeoutExpired:
            running.kill()

    def _read(self) -> None:
        running = self._process
        if running is None or running.stdout is None:
            return
        try:
            data = os.read(running.stdout.fileno(), BLOCK_BYTES * 8)
        except (BlockingIOError, OSError):
            return
        if not data:
            self._stop()
            return
        self._buffer += data
        peak: float | None = None
        while len(self._buffer) >= BLOCK_BYTES:
            block, self._buffer = self._buffer[:BLOCK_BYTES], self._buffer[BLOCK_BYTES:]
            measured = block_level(block)
            # Blocks that arrived together are one moment as far as the ring is
            # concerned, and the loudest of them is what was heard.
            peak = measured if peak is None else max(peak, measured)
        if peak is None:
            return
        if peak > self._level:
            self._level = peak
        else:
            self._level += (peak - self._level) * RELEASE
        if self._wanted:
            self._on_level(self._level)
