#!/usr/bin/env python3
"""Keep stable PipeWire defaults, routes, and voice ducking."""

from __future__ import annotations

import argparse
import functools
import json
import logging
import os
import re
import selectors
import signal
import socket
import subprocess
import tempfile
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


def default_sources(config: dict[str, Any]) -> dict[str, bool]:
    return {
        name: bool(source.get("enabled", False))
        for name, source in config["sources"].items()
    }


# A burst of pactl subscribe events (device hotplug, PipeWire restart) settles
# into one reconcile scheduled this far ahead of the first event.
EVENT_DEBOUNCE_SECONDS = 0.3

# Control-socket commands are tiny; a client that streams this much without a
# newline is broken and must not grow the buffer without limit.
MAX_CLIENT_BUFFER_BYTES = 64 * 1024

# Facilities whose subscribe events can invalidate the reconciled graph.
# `client` is deliberately excluded: every pactl invocation this process makes
# emits client events, which would schedule reconciles forever.
RELEVANT_FACILITIES = frozenset(
    {"sink", "source", "sink-input", "module", "server", "card"}
)


def is_relevant_event(line: str) -> bool:
    match = re.match(r"Event '[\w-]+' on ([\w-]+)", line)
    return match is not None and match.group(1) in RELEVANT_FACILITIES


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(json.dumps(value, indent=2) + "\n")
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


class AudioManager:
    def __init__(
        self,
        config_path: Path,
        socket_path: Path,
        status_path: Path,
        duck_state_path: Path,
    ) -> None:
        self.config = json.loads(config_path.read_text(encoding="utf-8"))
        self.socket_path = socket_path
        self.status_path = status_path
        self.duck_state_path = duck_state_path
        self.modules: dict[str, int] = {}
        self.bindings: dict[str, tuple[str, str]] = {}
        self.background_stream_index: int | None = None
        self.background_ducked: bool | None = None
        self.running = True
        # Desired route state lives in memory; the controller owns it through
        # the control socket and re-asserts it after either process restarts.
        self.sources = default_sources(self.config)
        self.selector = selectors.DefaultSelector()
        self.server: socket.socket | None = None
        self.clients: dict[socket.socket, bytes] = {}
        self.subscribe_process: subprocess.Popen[bytes] | None = None
        self.subscribe_buffer = b""
        self.subscribe_retry_at = 0.0
        self.pending_reconcile: float | None = None
        self.next_resync = 0.0

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

        # Only set defaults that are wrong: an unconditional set-default emits
        # a subscribe event on every reconcile, which would echo into another
        # scheduled reconcile and never quiesce.
        if sink and run("pactl", "get-default-sink", check=False).stdout.strip() != sink["name"]:
            run("pactl", "set-default-sink", sink["name"], check=False)
        if voice and run("pactl", "get-default-source", check=False).stdout.strip() != voice["name"]:
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
            enabled = self.sources.get(name, False)
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

    def state_event(self) -> dict[str, Any]:
        return {"event": "state", "sources": dict(self.sources)}

    def apply_command(self, message: Any) -> tuple[dict[str, Any], bool]:
        """Apply one socket command; returns (reply, reconcile needed)."""
        if not isinstance(message, dict):
            return {"event": "error", "error": "message must be a JSON object"}, False
        command = message.get("command")
        if command == "get-state":
            return self.state_event(), False
        if command == "resync":
            return self.state_event(), True
        if command == "set-source":
            name = message.get("name")
            requested = message.get("state")
            if name not in self.sources or requested not in ("on", "off", "toggle"):
                return {"event": "error", "error": "unknown source or state"}, False
            enabled = not self.sources[name] if requested == "toggle" else requested == "on"
            changed = self.sources[name] != enabled
            self.sources[name] = enabled
            return self.state_event(), changed
        if command == "set-sources":
            requested = message.get("sources")
            if not isinstance(requested, dict):
                return {"event": "error", "error": "set-sources needs a sources object"}, False
            changed = False
            for name in self.sources:
                enabled = requested.get(name)
                if isinstance(enabled, bool):
                    changed = changed or self.sources[name] != enabled
                    self.sources[name] = enabled
            return self.state_event(), changed
        return {"event": "error", "error": f"unknown command {command!r}"}, False

    def start_server(self) -> None:
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        self.socket_path.unlink(missing_ok=True)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.setblocking(False)
        server.bind(str(self.socket_path))
        server.listen()
        self.selector.register(server, selectors.EVENT_READ, self.accept_client)
        self.server = server
        LOG.info("Listening on %s", self.socket_path)

    def accept_client(self) -> None:
        if self.server is None:
            return
        try:
            connection, _ = self.server.accept()
        except OSError:
            return
        connection.setblocking(False)
        self.clients[connection] = b""
        self.selector.register(
            connection,
            selectors.EVENT_READ,
            functools.partial(self.read_client, connection),
        )

    def drop_client(self, connection: socket.socket) -> None:
        if connection not in self.clients:
            return
        del self.clients[connection]
        try:
            self.selector.unregister(connection)
        except (KeyError, ValueError):
            pass
        connection.close()

    def send_to(self, connection: socket.socket, event: dict[str, Any]) -> None:
        try:
            connection.sendall(json.dumps(event).encode("utf-8") + b"\n")
        except OSError:
            self.drop_client(connection)

    def broadcast_state(self) -> None:
        for connection in list(self.clients):
            self.send_to(connection, self.state_event())

    def read_client(self, connection: socket.socket) -> None:
        try:
            data = connection.recv(4096)
        except BlockingIOError:
            return
        except OSError:
            self.drop_client(connection)
            return
        if not data:
            self.drop_client(connection)
            return
        self.clients[connection] = self.clients.get(connection, b"") + data
        if len(self.clients[connection]) > MAX_CLIENT_BUFFER_BYTES:
            LOG.warning("Dropping control client flooding the socket")
            self.drop_client(connection)
            return
        while connection in self.clients and b"\n" in self.clients[connection]:
            line, _, self.clients[connection] = self.clients[connection].partition(b"\n")
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.send_to(connection, {"event": "error", "error": "invalid JSON"})
                continue
            reply, needs_reconcile = self.apply_command(message)
            if needs_reconcile:
                # Apply the change before answering so the state every client
                # receives is already live in the graph.
                self.safe_reconcile()
                self.broadcast_state()
            else:
                self.send_to(connection, reply)

    def start_subscribe(self) -> None:
        try:
            self.subscribe_process = subprocess.Popen(
                ["pactl", "subscribe"], stdout=subprocess.PIPE
            )
        except OSError as error:
            LOG.warning("pactl subscribe failed to start: %s", error)
            self.subscribe_process = None
            self.subscribe_retry_at = time.monotonic() + 1.0
            return
        stdout = self.subscribe_process.stdout
        assert stdout is not None
        os.set_blocking(stdout.fileno(), False)
        self.subscribe_buffer = b""
        self.selector.register(stdout, selectors.EVENT_READ, self.read_subscribe)

    def stop_subscribe(self) -> None:
        process = self.subscribe_process
        if process is None:
            return
        self.subscribe_process = None
        self.subscribe_retry_at = time.monotonic() + 1.0
        if process.stdout is not None:
            try:
                self.selector.unregister(process.stdout)
            except (KeyError, ValueError):
                pass
            process.stdout.close()
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()

    def read_subscribe(self) -> None:
        process = self.subscribe_process
        if process is None or process.stdout is None:
            return
        try:
            data = os.read(process.stdout.fileno(), 4096)
        except (BlockingIOError, OSError):
            return
        if not data:
            self.stop_subscribe()
            return
        self.subscribe_buffer += data
        while b"\n" in self.subscribe_buffer:
            line, _, self.subscribe_buffer = self.subscribe_buffer.partition(b"\n")
            if self.pending_reconcile is None and is_relevant_event(
                line.decode("utf-8", "replace")
            ):
                self.pending_reconcile = time.monotonic() + EVENT_DEBOUNCE_SECONDS

    def safe_reconcile(self) -> None:
        try:
            self.reconcile()
        except (
            subprocess.SubprocessError,
            json.JSONDecodeError,
            RuntimeError,
            OSError,
        ) as error:
            LOG.warning("Audio reconciliation failed: %s", error)
        self.pending_reconcile = None
        self.next_resync = time.monotonic() + float(
            self.config.get("resync_seconds", 900)
        )

    def execute(self) -> int:
        self.wait_for_pulse()
        self.start_server()
        self.start_subscribe()
        self.safe_reconcile()
        duck_poll = float(self.config.get("duck_poll_seconds", 0.1))
        while self.running:
            now = time.monotonic()
            deadline = min(
                now + duck_poll,
                self.next_resync,
                self.pending_reconcile
                if self.pending_reconcile is not None
                else self.next_resync,
            )
            for key, _ in self.selector.select(max(0.0, deadline - now)):
                key.data()
            if self.subscribe_process is not None and self.subscribe_process.poll() is not None:
                self.stop_subscribe()
            if self.subscribe_process is None and time.monotonic() >= self.subscribe_retry_at:
                LOG.info("Restarting pactl subscribe")
                self.start_subscribe()
                # Graph events may have been missed while the stream was down.
                if self.pending_reconcile is None:
                    self.pending_reconcile = time.monotonic()
            try:
                self.reconcile_ducking()
            except (
                subprocess.SubprocessError,
                json.JSONDecodeError,
                RuntimeError,
            ) as error:
                LOG.warning("Audio ducking failed: %s", error)
            now = time.monotonic()
            if now >= self.next_resync or (
                self.pending_reconcile is not None and now >= self.pending_reconcile
            ):
                self.safe_reconcile()
        self.stop_subscribe()
        for connection in list(self.clients):
            self.drop_client(connection)
        if self.server is not None:
            try:
                self.selector.unregister(self.server)
            except (KeyError, ValueError):
                pass
            self.server.close()
            self.socket_path.unlink(missing_ok=True)
        self.selector.close()
        for name in reversed(list(self.modules)):
            self.unload(name)
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--status", type=Path, required=True)
    parser.add_argument("--duck-state", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    manager = AudioManager(args.config, args.socket, args.status, args.duck_state)
    signal.signal(signal.SIGTERM, manager.stop)
    signal.signal(signal.SIGINT, manager.stop)
    return manager.execute()


if __name__ == "__main__":
    raise SystemExit(main())
