#!/usr/bin/env python3
"""Keep stable PipeWire defaults and optional input monitor loopbacks."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from typing import Any


LOG = logging.getLogger("smartamp-audio")


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True)


def pactl_json(kind: str) -> list[dict[str, Any]]:
    result = run("pactl", "--format=json", "list", kind)
    value = json.loads(result.stdout)
    if not isinstance(value, list):
        raise RuntimeError(f"Unexpected pactl result for {kind}")
    return value


def searchable(node: dict[str, Any]) -> str:
    properties = node.get("properties") or {}
    return " ".join(
        str(value)
        for value in (
            node.get("name", ""),
            node.get("description", ""),
            *properties.values(),
        )
    )


def is_monitor(node: dict[str, Any]) -> bool:
    return node.get("monitor_of_sink") not in (None, 4294967295, "4294967295") or str(
        node.get("name", "")
    ).endswith(".monitor")


def find_node(
    nodes: list[dict[str, Any]], pattern: str, *, allow_monitor: bool = False
) -> dict[str, Any] | None:
    matcher = re.compile(pattern, re.IGNORECASE)
    return next(
        (
            node
            for node in nodes
            if (allow_monitor or not is_monitor(node)) and matcher.search(searchable(node))
        ),
        None,
    )


def load_state(path: Path, config: dict[str, Any]) -> dict[str, Any]:
    defaults = {
        "sources": {
            name: bool(source.get("enabled", False))
            for name, source in config["sources"].items()
        }
    }
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(current.get("sources"), dict):
            defaults["sources"].update(current["sources"])
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    atomic_json(path, defaults)
    return defaults


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class AudioManager:
    def __init__(self, config_path: Path, state_path: Path, status_path: Path) -> None:
        self.config = json.loads(config_path.read_text(encoding="utf-8"))
        self.state_path = state_path
        self.status_path = status_path
        self.modules: dict[str, int] = {}
        self.running = True

    def stop(self, *_args: object) -> None:
        self.running = False

    def wait_for_pulse(self) -> None:
        while self.running:
            if run("pactl", "info", check=False).returncode == 0:
                return
            LOG.info("Waiting for PipeWire Pulse")
            time.sleep(1)

    def unload(self, source_name: str) -> None:
        module_id = self.modules.pop(source_name, None)
        if module_id is not None:
            run("pactl", "unload-module", str(module_id), check=False)

    def reconcile(self) -> None:
        sinks = pactl_json("sinks")
        sources = pactl_json("sources")
        sink = find_node(sinks, self.config["output_match"])
        voice = find_node(sources, self.config["voice_input_match"])
        state = load_state(self.state_path, self.config)
        status: dict[str, Any] = {
            "sink": sink.get("name") if sink else None,
            "voice_input": voice.get("name") if voice else None,
            "sources": {},
        }

        if sink:
            run("pactl", "set-default-sink", sink["name"], check=False)
        if voice:
            run("pactl", "set-default-source", voice["name"], check=False)

        aec_config = self.config.get("aec_reference", {})
        aec_sink = find_node(sinks, aec_config.get("sink_match", "a^"))
        monitor_name = f"{sink['name']}.monitor" if sink else None
        monitor = next((node for node in sources if node.get("name") == monitor_name), None)
        aec_ready = bool(aec_config.get("enabled", False) and aec_sink and monitor)
        status["aec_reference"] = {
            "enabled": bool(aec_config.get("enabled", False)),
            "available": bool(aec_sink and monitor),
            "sink": aec_sink.get("name") if aec_sink else None,
        }
        if aec_ready and "_aec" not in self.modules:
            result = run(
                "pactl",
                "load-module",
                "module-loopback",
                f"source={monitor['name']}",
                f"sink={aec_sink['name']}",
                f"latency_msec={int(aec_config.get('latency_ms', 40))}",
                "source_dont_move=true",
                "sink_dont_move=true",
            )
            self.modules["_aec"] = int(result.stdout.strip())
            LOG.info("Enabled XVF3800 AEC far-end reference")
        elif not aec_ready:
            self.unload("_aec")

        for name, source_config in self.config["sources"].items():
            node = find_node(sources, source_config["match"])
            enabled = bool(state["sources"].get(name, False))
            status["sources"][name] = {
                "enabled": enabled,
                "available": node is not None,
                "node": node.get("name") if node else None,
            }
            should_run = enabled and node is not None and sink is not None
            if should_run and name not in self.modules:
                result = run(
                    "pactl",
                    "load-module",
                    "module-loopback",
                    f"source={node['name']}",
                    f"sink={sink['name']}",
                    f"latency_msec={int(source_config.get('latency_ms', 40))}",
                    "source_dont_move=true",
                    "sink_dont_move=true",
                )
                self.modules[name] = int(result.stdout.strip())
                LOG.info("Enabled %s input monitor", name)
            elif not should_run:
                self.unload(name)

        atomic_json(self.status_path, status)

    def execute(self) -> int:
        self.wait_for_pulse()
        while self.running:
            try:
                self.reconcile()
            except (subprocess.SubprocessError, json.JSONDecodeError, RuntimeError) as error:
                LOG.warning("Audio reconciliation failed: %s", error)
            time.sleep(float(self.config.get("poll_seconds", 2)))
        for name in list(self.modules):
            self.unload(name)
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--status", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    manager = AudioManager(args.config, args.state, args.status)
    signal.signal(signal.SIGTERM, manager.stop)
    signal.signal(signal.SIGINT, manager.stop)
    return manager.execute()


if __name__ == "__main__":
    raise SystemExit(main())
