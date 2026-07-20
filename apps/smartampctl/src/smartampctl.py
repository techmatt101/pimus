#!/usr/bin/env python3
"""Small, non-privileged control surface for audio routes and LEDs."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Iterator


STATE_DIR = Path(os.environ.get("SMARTAMP_STATE_DIR", "/var/lib/smartamp"))
AUDIO_STATE = STATE_DIR / "audio-state.json"
LED_STATE = STATE_DIR / "led-state.json"


def status_path() -> Path:
    # The audio manager writes status into the smartamp service account's
    # runtime directory. Derive that account's UID from the state directory
    # owner so status also works when invoked by another (sudo-capable) user.
    try:
        uid = STATE_DIR.stat().st_uid
    except OSError:
        return Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / "smartamp-audio-status.json"
    return Path(f"/run/user/{uid}") / "smartamp-audio-status.json"


def read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(value, indent=2) + "\n"
    temporary_name: str | None = None
    try:
        # A unique file prevents simultaneous controller/CLI writes from
        # renaming another process's temporary file.
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(serialized)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


@contextmanager
def state_lock(path: Path, timeout_seconds: float = 2.0) -> Iterator[None]:
    """Use an atomic directory lock shared with the Node controller."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(f"{path}.lock")
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            os.mkdir(lock_path, 0o700)
            break
        except FileExistsError:
            # Recover a lock abandoned by a process that was killed mid-write.
            try:
                if time.time() - lock_path.stat().st_mtime > 30:
                    os.rmdir(lock_path)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out waiting for state lock {lock_path}")
            time.sleep(0.01)
    try:
        yield
    finally:
        try:
            os.rmdir(lock_path)
        except FileNotFoundError:
            pass


def update_json(
    path: Path,
    default: dict[str, Any],
    update: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    with state_lock(path):
        state = read_json(path, default)
        before = json.dumps(state, sort_keys=True)
        update(state)
        if json.dumps(state, sort_keys=True) != before:
            write_json(path, state)
        return state


def source(name: str, command: str) -> int:
    def update(state: dict[str, Any]) -> None:
        current = bool(state.setdefault("sources", {}).get(name, False))
        state["sources"][name] = not current if command == "toggle" else command == "on"

    state = update_json(AUDIO_STATE, {"sources": {}}, update)
    print(f"{name}={'on' if state['sources'][name] else 'off'}")
    return 0


def volume(command: str) -> int:
    operations = {
        "up": ["wpctl", "set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", "5%+"],
        "down": ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"],
        "mute": ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"],
    }
    return subprocess.run(operations[command], check=False).returncode


def lights(command: str) -> int:
    # Mirrors LOCAL_MODES in the controller's respeaker.mts; keep both aligned.
    modes = ["voice", "off", "single", "breath", "rainbow", "doa", "ring"]
    def update(state: dict[str, Any]) -> None:
        if command == "cycle":
            current = state.get("mode", "voice")
            state["mode"] = modes[(modes.index(current) + 1) % len(modes)] if current in modes else "voice"
        else:
            state["mode"] = command

    state = update_json(LED_STATE, {"mode": "voice", "color": "#00bcd4"}, update)
    print(f"lights={state['mode']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="smartampctl")
    subparsers = parser.add_subparsers(dest="area", required=True)
    source_parser = subparsers.add_parser("source")
    source_parser.add_argument("name", choices=["aux", "usb"])
    source_parser.add_argument("command", choices=["on", "off", "toggle"])
    volume_parser = subparsers.add_parser("volume")
    volume_parser.add_argument("command", choices=["up", "down", "mute"])
    lights_parser = subparsers.add_parser("lights")
    lights_parser.add_argument("command", choices=["cycle", "voice", "off", "single", "breath", "rainbow", "doa", "ring"])
    subparsers.add_parser("status")
    args = parser.parse_args()
    try:
        if args.area == "source":
            return source(args.name, args.command)
        if args.area == "volume":
            return volume(args.command)
        if args.area == "lights":
            return lights(args.command)
        print(json.dumps(read_json(status_path(), {}), indent=2))
        return 0
    except PermissionError as error:
        # State and status files belong to the smartamp service account; a
        # traceback here would hide the actual remedy from SSH users.
        print(f"smartampctl: {error}", file=sys.stderr)
        print(
            "State files belong to the smartamp service user; retry as, for "
            "example: sudo -u smartamp smartampctl ...",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
