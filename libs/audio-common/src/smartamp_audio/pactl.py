"""The pactl command surface: every PipeWire listing and mutation."""

from __future__ import annotations

import json
import subprocess
import time
from typing import Any, cast

from smartamp_audio import process


# When this process last moved a level or mute. Every such write comes straight
# back as a `change` subscribe event, which the event monitor uses this to
# recognise as an echo rather than a reason to reconcile again.
_last_level_write = 0.0


def last_level_write() -> float:
    return _last_level_write


def _note_level_write() -> None:
    global _last_level_write
    _last_level_write = time.monotonic()


def server_ready() -> bool:
    try:
        return process.run("pactl", "info", check=False).returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def list_json(kind: str) -> list[dict[str, Any]]:
    result = process.run("pactl", "--format=json", "list", kind)
    value: object = json.loads(result.stdout)
    if not isinstance(value, list):
        raise RuntimeError(f"Unexpected pactl result for {kind}")
    entries = cast(list[object], value)
    if not all(isinstance(entry, dict) for entry in entries):
        raise RuntimeError(f"Unexpected pactl result for {kind}")
    return cast(list[dict[str, Any]], entries)


def list_modules() -> list[dict[str, Any]]:
    # PipeWire's pactl (observed on 17.0) omits the module index from
    # `--format=json list modules`, so module adoption and cleanup parse the
    # short listing instead. A module argument can span several lines; the
    # continuation lines belong to the previous module.
    modules: list[dict[str, Any]] = []
    for line in process.run("pactl", "list", "short", "modules").stdout.splitlines():
        index, _, rest = line.partition("\t")
        if index.isdigit():
            name, _, argument = rest.partition("\t")
            modules.append(
                {"index": int(index), "name": name, "argument": argument.strip()}
            )
        elif modules:
            previous = modules[-1]
            previous["argument"] = f"{previous['argument']} {line.strip()}".strip()
    return modules


def load_module(module: str, *arguments: str) -> int:
    result = process.run("pactl", "load-module", module, *arguments)
    return int(result.stdout.strip())


def unload_module(module_id: int) -> None:
    process.run("pactl", "unload-module", str(module_id))


def set_sink_volume(sink_name: str, percent: int) -> None:
    process.run("pactl", "set-sink-volume", sink_name, f"{percent}%")
    _note_level_write()


def set_sink_mute(sink_name: str, muted: bool) -> None:
    process.run("pactl", "set-sink-mute", sink_name, "1" if muted else "0")
    _note_level_write()


def set_sink_input_volume(stream_index: int, percent: int) -> None:
    process.run("pactl", "set-sink-input-volume", str(stream_index), f"{percent}%")
    _note_level_write()


def set_sink_input_mute(stream_index: int, muted: bool) -> None:
    process.run("pactl", "set-sink-input-mute", str(stream_index), "1" if muted else "0")
    _note_level_write()


def default_sink() -> str:
    return process.run("pactl", "get-default-sink", check=False).stdout.strip()


def set_default_sink(sink_name: str) -> None:
    process.run("pactl", "set-default-sink", sink_name)


def set_card_profile(card_name: str, profile: str) -> None:
    process.run("pactl", "set-card-profile", card_name, profile)
