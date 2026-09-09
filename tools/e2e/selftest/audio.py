"""Stimulus and measurement: a tone or noise into a bus, a level off a monitor.

Every gain the manager sets is a PulseAudio percent, which PipeWire maps to a
cubic amplitude, so a level move is checked as the decibel step that mapping
predicts rather than as an absolute reading. Levels are measured as float
samples off a monitor source, which is the graph's own precision: a tone
that has been dipped 80 dB is still there to count.
"""

from __future__ import annotations

import math
import os
import random
import select
import struct
import subprocess
import time
import wave
from dataclasses import dataclass
from pathlib import Path

from .runtime import Runtime


RATE = 48000
TONE_HZ = 1000.0
# -20 dBFS: loud enough to sit far above any residual, quiet enough that a
# stray full-level path could never be startling.
STIMULUS_AMPLITUDE = 0.1
FLOOR_DB = -120.0


def expected_gain_db(percent: int) -> float:
    """The decibel gain a PulseAudio percent applies: cubic, 100% is unity."""
    if percent <= 0:
        return FLOOR_DB
    return 60.0 * math.log10(percent / 100.0)


def to_db(amplitude: float) -> float:
    if amplitude <= 0:
        return FLOOR_DB
    return max(FLOOR_DB, 20.0 * math.log10(amplitude))


def write_tone(path: Path, seconds: float, *, frequency: float = TONE_HZ,
               amplitude: float = STIMULUS_AMPLITUDE) -> Path:
    frames = int(seconds * RATE)
    samples = [
        amplitude * math.sin(2.0 * math.pi * frequency * index / RATE)
        for index in range(frames)
    ]
    return _write_wav(path, samples)


def write_noise(path: Path, seconds: float, *, amplitude: float = STIMULUS_AMPLITUDE,
                seed: int = 1) -> Path:
    generator = random.Random(seed)
    frames = int(seconds * RATE)
    samples = [amplitude * generator.uniform(-1.0, 1.0) for _ in range(frames)]
    return _write_wav(path, samples)


def _write_wav(path: Path, samples: list[float]) -> Path:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        frames = bytearray()
        for sample in samples:
            value = int(max(-1.0, min(1.0, sample)) * 32767)
            frames += struct.pack("<hh", value, value)
        handle.writeframes(bytes(frames))
    return path


class Player:
    """A paplay child streaming a file into one named sink."""

    def __init__(self, runtime: Runtime, sink: str, path: Path) -> None:
        self._runtime = runtime
        self._sink = sink
        self._path = path
        self._process: subprocess.Popen[bytes] | None = None

    def __enter__(self) -> Player:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()

    def start(self) -> None:
        self._process = self._runtime.user_spawn(
            [
                "paplay",
                f"--device={self._sink}",
                "--client-name=smartamp-selftest",
                str(self._path),
            ]
        )

    def stop(self) -> None:
        process = self._process
        self._process = None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None


@dataclass(frozen=True)
class Measurement:
    rms_db: float
    tone_db: float

    def describe(self) -> str:
        return f"rms {self.rms_db:.1f} dBFS, tone {self.tone_db:.1f} dBFS"


def capture(runtime: Runtime, source: str, seconds: float,
            *, frequency: float = TONE_HZ) -> Measurement | None:
    """`seconds` of `source` as one level pair, or None when nothing arrived."""
    frames = int(seconds * RATE)
    child = runtime.user_spawn(
        [
            "parec",
            f"--device={source}",
            "--format=float32le",
            f"--rate={RATE}",
            "--channels=1",
            "--latency-msec=40",
            "--client-name=smartamp-selftest",
        ]
    )
    stdout = child.stdout
    if stdout is None:
        return None
    try:
        data = _read_exactly(stdout.fileno(), frames * 4, timeout=seconds + 5.0, child=child)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
    if len(data) < frames * 4:
        return None
    samples = list(struct.unpack(f"<{frames}f", data[: frames * 4]))
    return analyse(samples, frequency=frequency)


def _read_exactly(descriptor: int, size: int, *, timeout: float,
                  child: subprocess.Popen[bytes]) -> bytes:
    buffer = bytearray()
    deadline = time.monotonic() + timeout
    while len(buffer) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or child.poll() is not None:
            break
        ready, _, _ = select.select([descriptor], [], [], min(remaining, 0.5))
        if not ready:
            continue
        chunk = os.read(descriptor, size - len(buffer))
        if not chunk:
            break
        buffer += chunk
    return bytes(buffer)


def analyse(samples: list[float], *, frequency: float = TONE_HZ,
            rate: int = RATE) -> Measurement:
    if not samples:
        return Measurement(FLOOR_DB, FLOOR_DB)
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    return Measurement(rms_db=to_db(rms), tone_db=to_db(tone_amplitude(samples, frequency, rate)))


def tone_amplitude(samples: list[float], frequency: float, rate: int) -> float:
    """Goertzel's estimate of the amplitude of one sinusoid in the samples."""
    count = len(samples)
    if count == 0:
        return 0.0
    coefficient = 2.0 * math.cos(2.0 * math.pi * frequency / rate)
    previous = 0.0
    before = 0.0
    for sample in samples:
        current = sample + coefficient * previous - before
        before = previous
        previous = current
    power = previous * previous + before * before - coefficient * previous * before
    return 2.0 * math.sqrt(max(0.0, power)) / count
