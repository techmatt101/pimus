"""Every child process the daemon runs, traced through one place."""

from __future__ import annotations

import logging
import subprocess


LOG = logging.getLogger(__name__)

# `pactl` and `amixer` should complete almost immediately. Bound them so a
# wedged PipeWire or ALSA helper cannot freeze the manager's selector loop.
COMMAND_TIMEOUT_SECONDS = 5.0


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        check=check,
        text=True,
        capture_output=True,
        timeout=COMMAND_TIMEOUT_SECONDS,
    )
    # Every pactl and amixer mutation and query passes through here, so the
    # debug journal is the full trace of what the manager did and when.
    LOG.debug("%s -> rc %d", " ".join(args), result.returncode)
    return result


def spawn(command: list[str], *, quiet_stderr: bool = False) -> subprocess.Popen[bytes]:
    """Start a long-running child whose stdout this daemon reads line by line."""
    return subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL if quiet_stderr else None,
    )
