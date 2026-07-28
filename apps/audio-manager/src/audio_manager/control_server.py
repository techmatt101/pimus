"""The Unix control socket: newline-delimited JSON, one connection per client."""

from __future__ import annotations

import functools
import json
import logging
import selectors
import socket
from pathlib import Path
from typing import Any, Callable, Protocol


LOG = logging.getLogger(__name__)

# Control-socket commands are tiny; a client that streams this much without a
# newline is broken and must not grow the buffer without limit.
MAX_CLIENT_BUFFER_BYTES = 64 * 1024


class Commands(Protocol):
    def apply(
        self, connection: socket.socket, message: Any
    ) -> tuple[dict[str, Any], bool]:
        """Applies one command; returns its reply and whether to reconcile."""

    def client_gone(self, connection: socket.socket) -> None:
        """Releases anything held on behalf of a connection that closed."""


class ControlServer:
    def __init__(
        self,
        socket_path: Path,
        selector: selectors.BaseSelector,
        commands: Commands,
        on_reconcile: Callable[[], None],
    ) -> None:
        self.socket_path = socket_path
        self.clients: dict[socket.socket, bytes] = {}
        self._selector = selector
        self._commands = commands
        self._on_reconcile = on_reconcile
        self._server: socket.socket | None = None

    def start(self) -> None:
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        self.socket_path.unlink(missing_ok=True)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.setblocking(False)
        server.bind(str(self.socket_path))
        server.listen()
        self._selector.register(server, selectors.EVENT_READ, self._accept)
        self._server = server
        LOG.info("Listening on %s", self.socket_path)

    def close(self) -> None:
        for connection in list(self.clients):
            self.drop(connection)
        if self._server is None:
            return
        try:
            self._selector.unregister(self._server)
        except (KeyError, ValueError):
            pass
        self._server.close()
        self._server = None
        self.socket_path.unlink(missing_ok=True)

    def send(self, connection: socket.socket, event: dict[str, Any]) -> None:
        try:
            connection.sendall(json.dumps(event).encode("utf-8") + b"\n")
        except OSError:
            self.drop(connection)

    def broadcast(self, event: dict[str, Any]) -> None:
        for connection in list(self.clients):
            self.send(connection, event)

    def drop(self, connection: socket.socket) -> None:
        if connection not in self.clients:
            return
        del self.clients[connection]
        try:
            self._selector.unregister(connection)
        except (KeyError, ValueError):
            pass
        connection.close()
        self._commands.client_gone(connection)

    def read(self, connection: socket.socket) -> None:
        try:
            data = connection.recv(4096)
        except BlockingIOError:
            return
        except OSError:
            self.drop(connection)
            return
        if not data:
            self.drop(connection)
            return
        self.clients[connection] = self.clients.get(connection, b"") + data
        if len(self.clients[connection]) > MAX_CLIENT_BUFFER_BYTES:
            LOG.warning("Dropping control client flooding the socket")
            self.drop(connection)
            return
        while connection in self.clients and b"\n" in self.clients[connection]:
            buffered = self.clients[connection]
            line, _, self.clients[connection] = buffered.partition(b"\n")
            if line.strip():
                self._handle(connection, line)

    def _handle(self, connection: socket.socket, line: bytes) -> None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            self.send(connection, {"event": "error", "error": "invalid JSON"})
            return
        reply, needs_reconcile = self._commands.apply(connection, message)
        if needs_reconcile:
            # Apply the change before answering so the state every client
            # receives is already live in the graph.
            self._on_reconcile()
        else:
            self.send(connection, reply)

    def _accept(self) -> None:
        if self._server is None:
            return
        try:
            connection, _ = self._server.accept()
        except OSError:
            return
        connection.setblocking(False)
        self.clients[connection] = b""
        self._selector.register(
            connection,
            selectors.EVENT_READ,
            functools.partial(self.read, connection),
        )
