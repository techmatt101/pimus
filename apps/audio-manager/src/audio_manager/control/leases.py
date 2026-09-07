"""The requests a client holds open for as long as its connection lasts."""

from __future__ import annotations

import socket
from typing import NamedTuple


class Released(NamedTuple):
    duck: bool
    meter: bool


class Leases:
    """Ducking and metering, each held against the connection that asked.

    Holding a request against its socket makes the socket the liveness
    signal: if the controller crashes mid-conversation the kernel closes its
    end, the lease is released, and the music restores at once, with no
    timestamped lease file to expire. Either lease also marks a live voice
    session, well before its first TTS stream exists.
    """

    def __init__(self) -> None:
        self._duck: set[socket.socket] = set()
        self._meter: set[socket.socket] = set()

    @property
    def duck_requested(self) -> bool:
        return bool(self._duck)

    @property
    def meter_listeners(self) -> frozenset[socket.socket]:
        """The connections that asked for voice levels, and get them addressed."""
        return frozenset(self._meter)

    @property
    def held(self) -> bool:
        return bool(self._duck or self._meter)

    def request_duck(self, connection: socket.socket, active: bool) -> None:
        _hold(self._duck, connection, active)

    def request_meter(self, connection: socket.socket, active: bool) -> None:
        _hold(self._meter, connection, active)

    def release(self, connection: socket.socket) -> Released:
        """Drop everything the connection held; says which kinds that changed."""
        released = Released(connection in self._duck, connection in self._meter)
        self._duck.discard(connection)
        self._meter.discard(connection)
        return released


def _hold(leases: set[socket.socket], connection: socket.socket, active: bool) -> None:
    if active:
        leases.add(connection)
    else:
        leases.discard(connection)
