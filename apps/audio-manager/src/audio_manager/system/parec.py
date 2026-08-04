"""Capturing a PipeWire node as raw PCM on a child's stdout."""

from __future__ import annotations

import subprocess

from . import process


def capture_mono(
    source: str, *, rate: int, latency_ms: int, client_name: str
) -> subprocess.Popen[bytes]:
    """A child streaming `source` to stdout as little-endian 16-bit mono.

    The latency is what decides how often a block arrives, so a caller reading
    fixed-size blocks gets one per interval rather than a stream it must pace
    itself. parec writes a WAV header only when told to write a file, so stdout
    carries nothing but samples.
    """
    return process.spawn(
        [
            "parec",
            f"--device={source}",
            "--format=s16le",
            f"--rate={rate}",
            "--channels=1",
            f"--latency-msec={latency_ms}",
            f"--client-name={client_name}",
        ],
        quiet_stderr=True,
    )
