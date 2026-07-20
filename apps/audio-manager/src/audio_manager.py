#!/usr/bin/env python3
"""Keep stable PipeWire defaults, routes, and voice ducking."""

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


def find_owned_stream(
    streams: list[dict[str, Any]], module_id: int | None, media_name: str = ""
) -> dict[str, Any] | None:
    if module_id is None and not media_name:
        return None
    return next(
        (
            stream
            for stream in streams
            if (module_id is not None and str(stream.get("owner_module")) == str(module_id))
            or (
                media_name
                and (stream.get("properties") or {}).get("media.name") == media_name
            )
        ),
        None,
    )


def find_loaded_module(
    modules: list[dict[str, Any]], module_name: str, required_arguments: tuple[str, ...]
) -> dict[str, Any] | None:
    return next(
        (
            module
            for module in modules
            if module.get("name") == module_name
            and all(
                argument in str(module.get("argument", "")).split()
                for argument in required_arguments
            )
        ),
        None,
    )


def duck_request_active(path: Path, timeout_seconds: float, now: float) -> bool:
    try:
        request = json.loads(path.read_text(encoding="utf-8"))
        updated_at = float(request.get("updated_at", 0))
        return bool(request.get("active", False)) and now <= updated_at + timeout_seconds
    except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError, ValueError):
        return False


def load_state(path: Path, config: dict[str, Any]) -> dict[str, Any]:
    defaults = {
        "sources": {
            name: bool(source.get("enabled", False))
            for name, source in config["sources"].items()
        }
    }
    current: Any = None
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(current, dict) and isinstance(current.get("sources"), dict):
            defaults["sources"].update(current["sources"])
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    # This runs every reconcile and the state lives on the SD card, so only
    # rewrite when the merged content differs. An unconditional write would
    # wear flash and widen the window for losing a concurrent smartampctl
    # toggle between the read above and the write below.
    if current != defaults:
        atomic_json(path, defaults)
    return defaults


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class AudioManager:
    def __init__(
        self,
        config_path: Path,
        state_path: Path,
        status_path: Path,
        duck_state_path: Path,
    ) -> None:
        self.config = json.loads(config_path.read_text(encoding="utf-8"))
        self.state_path = state_path
        self.status_path = status_path
        self.duck_state_path = duck_state_path
        self.modules: dict[str, int] = {}
        self.bindings: dict[str, tuple[str, str]] = {}
        self.background_stream_index: int | None = None
        self.background_ducked: bool | None = None
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
        self.bindings.pop(source_name, None)
        if source_name == "_background_bridge":
            self.background_stream_index = None
            self.background_ducked = None
        if module_id is not None:
            run("pactl", "unload-module", str(module_id), check=False)

    def refresh_modules(self) -> None:
        loaded_ids = {
            int(module["index"])
            for module in pactl_json("modules")
            if module.get("index") is not None
        }
        for name, module_id in list(self.modules.items()):
            if module_id in loaded_ids:
                continue
            self.modules.pop(name, None)
            self.bindings.pop(name, None)
            if name == "_background_bridge":
                self.background_stream_index = None
                self.background_ducked = None
            LOG.info("PipeWire removed %s; it will be recreated", name)

    def load_module(self, name: str, module: str, *arguments: str) -> int:
        result = run("pactl", "load-module", module, *arguments)
        module_id = int(result.stdout.strip())
        self.modules[name] = module_id
        return module_id

    def ensure_loopback(
        self, name: str, source: str, sink: str, latency_ms: int
    ) -> bool:
        binding = (source, sink)
        if self.bindings.get(name) not in (None, binding):
            self.unload(name)
        if name not in self.modules:
            existing = find_loaded_module(
                pactl_json("modules"),
                "module-loopback",
                (f"source={source}", f"sink={sink}"),
            )
            if existing is not None:
                self.modules[name] = int(existing["index"])
                self.bindings[name] = binding
        if name in self.modules:
            return False
        media_name = f"SmartAmp.{name.strip('_')}"
        self.load_module(
            name,
            "module-loopback",
            f"source={source}",
            f"sink={sink}",
            f"latency_msec={latency_ms}",
            "source_dont_move=true",
            "sink_dont_move=true",
            f"sink_input_properties=media.name={media_name}",
        )
        self.bindings[name] = binding
        return True

    def desired_ducking(self) -> bool:
        background_config = self.config.get("background", {})
        if not background_config.get("enabled", False):
            return False
        return duck_request_active(
            self.duck_state_path,
            float(background_config.get("duck_timeout_seconds", 120)),
            time.time(),
        )

    def set_background_ducking(self, ducked: bool) -> None:
        if self.background_stream_index is None or self.background_ducked == ducked:
            return
        background_config = self.config.get("background", {})
        duck_volume = max(
            0, min(100, int(background_config.get("duck_volume_percent", 15)))
        )
        target_volume = duck_volume if ducked else 100
        if self.background_ducked is None:
            start_volume = target_volume
        else:
            start_volume = duck_volume if self.background_ducked else 100
        fade_ms = max(0, int(background_config.get("fade_ms", 250)))
        steps = (
            1
            if start_volume == target_volume
            else max(1, min(10, fade_ms // 50))
        )
        delay = fade_ms / steps / 1000 if fade_ms else 0
        for step in range(1, steps + 1):
            volume = round(start_volume + (target_volume - start_volume) * step / steps)
            run(
                "pactl",
                "set-sink-input-volume",
                str(self.background_stream_index),
                f"{volume}%",
            )
            if delay and step < steps:
                time.sleep(delay)
        self.background_ducked = ducked
        LOG.info("%s background audio", "Ducked" if ducked else "Restored")

    def reconcile_ducking(self) -> bool:
        ducked = self.desired_ducking()
        self.set_background_ducking(ducked)
        return ducked

    def ensure_background(
        self,
        sinks: list[dict[str, Any]],
        sources: list[dict[str, Any]],
        output: dict[str, Any] | None,
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]], list[dict[str, Any]]]:
        background_config = self.config.get("background", {})
        if not background_config.get("enabled", False):
            self.unload("_background_bridge")
            self.unload("_background_sink")
            return None, sinks, sources

        sink_name = str(background_config.get("sink_name", "smartamp_background"))
        background_sink = next(
            (candidate for candidate in sinks if candidate.get("name") == sink_name),
            None,
        )
        if background_sink is None and "_background_sink" not in self.modules:
            self.load_module(
                "_background_sink",
                "module-null-sink",
                f"sink_name={sink_name}",
                (
                    "sink_properties="
                    "device.description=SmartAmp_Background_Audio priority.session=1"
                ),
            )
            LOG.info("Created background audio sink")
        if background_sink is None:
            sinks = pactl_json("sinks")
            sources = pactl_json("sources")
            background_sink = next(
                (candidate for candidate in sinks if candidate.get("name") == sink_name),
                None,
            )
        elif "_background_sink" not in self.modules:
            owner_module = background_sink.get("owner_module")
            if owner_module is not None:
                self.modules["_background_sink"] = int(owner_module)

        monitor_name = f"{sink_name}.monitor"
        monitor = next(
            (candidate for candidate in sources if candidate.get("name") == monitor_name),
            None,
        )
        if output and monitor:
            created = self.ensure_loopback(
                "_background_bridge",
                monitor_name,
                output["name"],
                int(background_config.get("latency_ms", 40)),
            )
            if created:
                self.background_ducked = None
                LOG.info("Connected background audio to HiFiBerry output")
            sink_inputs = pactl_json("sink-inputs")
            bridge = find_owned_stream(
                sink_inputs,
                self.modules.get("_background_bridge"),
                "SmartAmp.background_bridge",
            )
            stream_index = (
                int(bridge["index"]) if bridge is not None else None
            )
            if stream_index != self.background_stream_index:
                self.background_ducked = None
            self.background_stream_index = stream_index
        else:
            self.unload("_background_bridge")

        return background_sink, sinks, sources

    def reconcile(self) -> None:
        self.refresh_modules()
        sinks = pactl_json("sinks")
        sources = pactl_json("sources")
        sink = find_node(sinks, self.config["output_match"])
        background_sink, sinks, sources = self.ensure_background(sinks, sources, sink)
        voice = find_node(sources, self.config["voice_input_match"])
        state = load_state(self.state_path, self.config)
        ducked = self.reconcile_ducking()
        status: dict[str, Any] = {
            "sink": sink.get("name") if sink else None,
            "voice_input": voice.get("name") if voice else None,
            "background": {
                "available": bool(
                    background_sink and self.background_stream_index is not None
                ),
                "sink": background_sink.get("name") if background_sink else None,
                "ducked": ducked,
            },
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
        if aec_ready:
            created = self.ensure_loopback(
                "_aec",
                monitor["name"],
                aec_sink["name"],
                int(aec_config.get("latency_ms", 40)),
            )
            if created:
                LOG.info("Enabled XVF3800 AEC far-end reference")
        else:
            self.unload("_aec")

        for name, source_config in self.config["sources"].items():
            node = find_node(sources, source_config["match"])
            enabled = bool(state["sources"].get(name, False))
            status["sources"][name] = {
                "enabled": enabled,
                "available": node is not None,
                "node": node.get("name") if node else None,
            }
            target = (
                background_sink
                if source_config.get("target") == "background"
                else sink
            )
            should_run = enabled and node is not None and target is not None
            if should_run:
                created = self.ensure_loopback(
                    name,
                    node["name"],
                    target["name"],
                    int(source_config.get("latency_ms", 40)),
                )
                if created:
                    LOG.info("Enabled %s input monitor", name)
            else:
                self.unload(name)

        atomic_json(self.status_path, status)

    def execute(self) -> int:
        self.wait_for_pulse()
        next_reconcile = 0.0
        while self.running:
            now = time.monotonic()
            if now >= next_reconcile:
                try:
                    self.reconcile()
                except (
                    subprocess.SubprocessError,
                    json.JSONDecodeError,
                    RuntimeError,
                ) as error:
                    LOG.warning("Audio reconciliation failed: %s", error)
                next_reconcile = time.monotonic() + float(
                    self.config.get("poll_seconds", 2)
                )
            else:
                try:
                    self.reconcile_ducking()
                except (
                    subprocess.SubprocessError,
                    json.JSONDecodeError,
                    RuntimeError,
                ) as error:
                    LOG.warning("Audio ducking failed: %s", error)
                time.sleep(
                    min(
                        float(self.config.get("duck_poll_seconds", 0.1)),
                        max(0, next_reconcile - time.monotonic()),
                    )
                )
        for name in reversed(list(self.modules)):
            self.unload(name)
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--status", type=Path, required=True)
    parser.add_argument("--duck-state", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    manager = AudioManager(args.config, args.state, args.status, args.duck_state)
    signal.signal(signal.SIGTERM, manager.stop)
    signal.signal(signal.SIGINT, manager.stop)
    return manager.execute()


if __name__ == "__main__":
    raise SystemExit(main())
