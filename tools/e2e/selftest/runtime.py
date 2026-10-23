"""The suite's one boundary with the Pi: every command it runs goes through here.

The suite runs as root, because restarting units, reading the journal and
talking to the microphone array's control endpoint need it, but the PipeWire
graph belongs to the service account's session. Anything that touches audio
is therefore re-run as that user with its session in the environment, exactly
as the doctor does, so no root-owned PipeWire client is ever left behind.
Tests patch `smartamp_audio.process`, which is where every child is spawned.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, cast

from smartamp_audio import process

from .config import SelftestConfig


# A synchronous restart waits for the unit, and every unit bound to it, to
# stop and start again, which on a Pi takes far longer than a pactl call.
SYSTEMD_TIMEOUT_SECONDS = 120.0


class Runtime:
    def __init__(self, config: SelftestConfig) -> None:
        self.config = config

    # The service account's PipeWire session, as the units set it. LC_ALL=C
    # keeps pactl's listings in the English the shared parsers read.
    def session_environment(self) -> list[str]:
        runtime_dir = self.config.runtime_dir
        return [
            "env",
            f"XDG_RUNTIME_DIR={runtime_dir}",
            f"PULSE_SERVER={runtime_dir}/pulse/native",
            "LC_ALL=C",
        ]

    def as_service_user(self, argv: list[str]) -> list[str]:
        command = [*self.session_environment(), *argv]
        if os.geteuid() == self.config.uid:
            return command
        return ["runuser", "-u", self.config.service_user, "--", *command]

    def run(self, *argv: str, timeout: float = process.COMMAND_TIMEOUT_SECONDS
            ) -> subprocess.CompletedProcess[str]:
        try:
            return process.run(*argv, check=False, timeout=timeout)
        except (subprocess.SubprocessError, OSError) as error:
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr=str(error))

    def user_run(self, *argv: str) -> subprocess.CompletedProcess[str]:
        return self.run(*self.as_service_user(list(argv)))

    def user_spawn(self, argv: list[str]) -> subprocess.Popen[bytes]:
        return process.spawn(self.as_service_user(argv), quiet_stderr=True)

    # PipeWire, read as the shared graph helpers expect it.

    def pactl_list(self, kind: str) -> list[dict[str, Any]]:
        result = self.user_run("pactl", "--format=json", "list", kind)
        if result.returncode != 0:
            return []
        try:
            value: object = json.loads(result.stdout)
        except json.JSONDecodeError:
            return []
        if not isinstance(value, list):
            return []
        return [
            cast(dict[str, Any], entry)
            for entry in cast(list[object], value)
            if isinstance(entry, dict)
        ]

    def pactl(self, *argv: str) -> str:
        result = self.user_run("pactl", *argv)
        return result.stdout.strip() if result.returncode == 0 else ""

    def source_names(self) -> list[str]:
        return [str(node.get("name", "")) for node in self.pactl_list("sources")]

    # Files the daemons publish.

    def read_json(self, path: Path) -> dict[str, Any] | None:
        try:
            value: object = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return cast(dict[str, Any], value) if isinstance(value, dict) else None

    def user_can_write(self, path: str) -> bool:
        return self.user_run("test", "-w", path).returncode == 0

    # systemd and the journal.

    def unit_active(self, unit: str) -> bool:
        return self.run("systemctl", "is-active", "--quiet", unit).returncode == 0

    def systemctl(self, *argv: str) -> bool:
        return self.run("systemctl", *argv, timeout=SYSTEMD_TIMEOUT_SECONDS).returncode == 0

    def journal(self, unit: str, since: str) -> str:
        result = self.run(
            "journalctl", "-u", unit, "--since", since, "--no-pager", "-o", "cat",
            timeout=SYSTEMD_TIMEOUT_SECONDS,
        )
        return result.stdout if result.returncode == 0 else ""

    def journal_since_start(self, unit: str) -> str | None:
        """The unit's log lines from its current start; None when it has none."""
        result = self.run("systemctl", "show", "-p", "InvocationID", "--value", unit)
        invocation = result.stdout.strip() if result.returncode == 0 else ""
        if not invocation:
            return None
        result = self.run(
            "journalctl", f"_SYSTEMD_INVOCATION_ID={invocation}", "--no-pager", "-o", "cat",
            timeout=SYSTEMD_TIMEOUT_SECONDS,
        )
        return result.stdout if result.returncode == 0 else None

    # Devices.

    def usb_present(self, usb_id: str) -> bool:
        result = self.run("lsusb")
        return result.returncode == 0 and usb_id.lower() in result.stdout.lower()

    def alsa_playback_cards(self) -> str:
        return self.run("aplay", "-l").stdout

    def xvf_host(self, command: str) -> str | None:
        """One control read of the array; None when the tool or device fails."""
        result = self.run("xvf_host", command)
        if result.returncode != 0:
            return None
        return result.stdout.strip()

    def amixer_set_percent(self, card: str, control: str, percent: int) -> bool:
        return self.run("amixer", "-c", card, "sset", control, f"{percent}%").returncode == 0

    def amixer_percent(self, card: str, control: str) -> int | None:
        result = self.run("amixer", "-c", card, "sget", control)
        if result.returncode != 0:
            return None
        levels: list[int] = []
        for line in result.stdout.splitlines():
            if ": Playback " not in line or "%]" not in line:
                continue
            start = line.index("[") + 1
            end = line.index("%]")
            try:
                levels.append(int(line[start:end]))
            except ValueError:
                continue
        return min(levels) if levels else None
