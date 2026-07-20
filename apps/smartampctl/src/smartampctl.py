#!/usr/bin/env python3
"""Small, non-privileged control surface for audio routes and LEDs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


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
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def source(name: str, command: str) -> int:
    state = read_json(AUDIO_STATE, {"sources": {}})
    current = bool(state.setdefault("sources", {}).get(name, False))
    state["sources"][name] = not current if command == "toggle" else command == "on"
    write_json(AUDIO_STATE, state)
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
    state = read_json(LED_STATE, {"mode": "voice", "color": "#00bcd4"})
    if command == "cycle":
        current = state.get("mode", "voice")
        state["mode"] = modes[(modes.index(current) + 1) % len(modes)] if current in modes else "voice"
    else:
        state["mode"] = command
    write_json(LED_STATE, state)
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
