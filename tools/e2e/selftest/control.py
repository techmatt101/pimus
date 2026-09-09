"""A client of the audio manager's control socket: newline-delimited JSON.

A command is answered by a `state` or `error` event, except that a command
which reconciles the graph answers every client with a broadcast `state`
instead of replying to the sender alone, and the daemon also broadcasts
whenever its state drifts. So the client never counts replies: it reads
events until one answers the question, and `wait_for` polls `get-state`
until the graph looks the way a check expects.
"""

from __future__ import annotations

import json
import socket
import time
from pathlib import Path
from typing import Any, Callable, cast


Event = dict[str, Any]

DEFAULT_TIMEOUT_SECONDS = 5.0
POLL_SECONDS = 0.25


class ControlClient:
    def __init__(self, path: Path, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self.path = path
        self.timeout = timeout
        self._socket: socket.socket | None = None
        self._buffer = b""

    def __enter__(self) -> ControlClient:
        self.connect()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def connect(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        try:
            connection.connect(str(self.path))
        except OSError:
            connection.close()
            raise
        self._socket = connection

    def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    @property
    def connected(self) -> bool:
        return self._socket is not None

    def send(self, message: dict[str, Any]) -> None:
        if self._socket is None:
            raise ConnectionError("not connected")
        self._socket.sendall(json.dumps(message).encode("utf-8") + b"\n")

    def next_event(self, timeout: float | None = None) -> Event | None:
        """The next event, or None when nothing arrived in time."""
        if self._socket is None:
            raise ConnectionError("not connected")
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        while True:
            line, separator, rest = self._buffer.partition(b"\n")
            if separator:
                self._buffer = rest
                if line.strip():
                    return self._parse(line)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self._socket.settimeout(remaining)
            try:
                data = self._socket.recv(65536)
            except socket.timeout:
                return None
            if not data:
                raise ConnectionError("the audio manager closed the socket")
            self._buffer += data

    def command(self, name: str, /, **fields: Any) -> Event:
        """Sends a command and answers with the state or error it produced.

        A state the daemon broadcast earlier would otherwise be taken for the
        answer, so whatever has already arrived is read off first; a check
        that must see a change land polls `wait_for` rather than trusting
        one reply.
        """
        while self.next_event(0.0) is not None:
            pass
        self.send({"command": name, **fields})
        deadline = time.monotonic() + self.timeout
        while True:
            event = self.next_event(max(0.0, deadline - time.monotonic()))
            if event is None:
                raise TimeoutError(f"no answer to {name}")
            if event.get("event") in ("state", "error"):
                return event

    def state(self) -> Event:
        event = self.command("get-state")
        if event.get("event") != "state":
            raise RuntimeError(f"get-state answered {event}")
        return event

    def wait_for(
        self, predicate: Callable[[Event], bool], timeout: float, what: str = ""
    ) -> Event | None:
        """The first state satisfying `predicate` within `timeout`, else None."""
        deadline = time.monotonic() + timeout
        while True:
            state = self.state()
            if predicate(state):
                return state
            if time.monotonic() >= deadline:
                return None
            time.sleep(POLL_SECONDS)

    def drain(self, seconds: float) -> list[Event]:
        """Every event arriving over `seconds`, for a lease that streams them."""
        events: list[Event] = []
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return events
            event = self.next_event(remaining)
            if event is not None:
                events.append(event)

    @staticmethod
    def _parse(line: bytes) -> Event:
        try:
            value: object = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"event": "malformed", "raw": line.decode("utf-8", "replace")}
        if isinstance(value, dict):
            return cast(Event, value)
        return {"event": "malformed", "raw": value}


def section(state: Event, *keys: str) -> Any:
    """A nested value of a state event, or None where the path is missing."""
    value: Any = state
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = cast(dict[str, Any], value).get(key)
    return value
