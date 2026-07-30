"""The control-socket protocol: one handler per command, validation included."""

from __future__ import annotations

import json
import logging
import socket
from typing import TYPE_CHECKING, Any, Callable

from . import volume


if TYPE_CHECKING:
    from .daemon import AudioManager


LOG = logging.getLogger(__name__)

Reply = tuple[dict[str, Any], bool]


def _error(message: str) -> Reply:
    return {"event": "error", "error": message}, False


class CommandHandler:
    """Applies socket commands to the manager, and holds the ducking leases.

    A duck request is held against the connection that asked for it, which
    makes the socket itself the liveness signal: if the controller crashes
    mid-conversation the kernel closes its socket and background audio restores
    immediately, with no timestamped lease file to expire.
    """

    def __init__(self, manager: AudioManager) -> None:
        self._manager = manager
        self._duck_requests: set[socket.socket] = set()
        self._meter_requests: set[socket.socket] = set()
        self._standby_requests: set[socket.socket] = set()
        self._handlers: dict[str, Callable[[socket.socket, dict[str, Any]], Reply]] = {
            "set-duck": self._set_duck,
            "set-standby": self._set_standby,
            "set-voice-meter": self._set_voice_meter,
            "set-voice-volume": self._set_voice_volume,
            "set-music-volume": self._set_music_volume,
            "set-output-mute": self._set_output_mute,
            "set-source": self._set_source,
            "set-sources": self._set_sources,
            "get-state": self._get_state,
            "resync": self._resync,
        }

    @property
    def duck_requested(self) -> bool:
        return bool(self._duck_requests)

    @property
    def standby_requested(self) -> bool:
        return bool(self._standby_requests)

    @property
    def meter_listeners(self) -> frozenset[socket.socket]:
        """The connections that asked for voice levels, and get them addressed."""
        return frozenset(self._meter_requests)

    def apply(self, connection: socket.socket, message: Any) -> Reply:
        if not isinstance(message, dict):
            return _error("message must be a JSON object")
        LOG.debug("socket command: %s", json.dumps(message))
        handler = self._handlers.get(message.get("command"))
        if handler is None:
            return _error(f"unknown command {message.get('command')!r}")
        return handler(connection, message)

    def client_gone(self, connection: socket.socket) -> None:
        if connection in self._meter_requests:
            self._meter_requests.discard(connection)
            self._manager.request_voice_meter(bool(self._meter_requests))
        if connection in self._standby_requests:
            # Releasing on disconnect rebuilds the bridges, which is the safe
            # side: a crashed controller reconnects and re-asserts within
            # seconds, exactly as it re-asserts a duck.
            self._standby_requests.discard(connection)
            if self._manager.running:
                self._manager.sync_standby()
        if connection not in self._duck_requests:
            return
        self._duck_requests.discard(connection)
        if self._manager.running:
            self._manager.safe_apply_ducking()

    def _set_duck(self, connection: socket.socket, message: dict[str, Any]) -> Reply:
        active = message.get("active")
        if not isinstance(active, bool):
            return _error("set-duck needs a boolean active")
        if active:
            self._duck_requests.add(connection)
            # A duck request opens a voice session seconds before its first
            # TTS stream exists — the earliest moment an idle teardown can
            # start rebuilding, so the reply plays through a ready bridge.
            self._manager.notice_voice_activity()
        else:
            self._duck_requests.discard(connection)
        # Ducking only touches the background stream volume, so apply it
        # directly instead of asking for a full graph reconcile.
        self._manager.safe_apply_ducking()
        return self._state()

    def _set_standby(
        self, connection: socket.socket, message: dict[str, Any]
    ) -> Reply:
        active = message.get("active")
        if not isinstance(active, bool):
            return _error("set-standby needs a boolean active")
        if active:
            self._standby_requests.add(connection)
        else:
            self._standby_requests.discard(connection)
        self._manager.sync_standby()
        return self._state()

    def _set_voice_meter(
        self, connection: socket.socket, message: dict[str, Any]
    ) -> Reply:
        active = message.get("active")
        if not isinstance(active, bool):
            return _error("set-voice-meter needs a boolean active")
        if active:
            self._meter_requests.add(connection)
            # A meter request marks a live voice session, exactly as a duck
            # request does.
            self._manager.notice_voice_activity()
        else:
            self._meter_requests.discard(connection)
        # Metering only starts or stops a capture of the voice monitor; it
        # changes nothing about the graph the daemon reconciles.
        self._manager.request_voice_meter(bool(self._meter_requests))
        return self._state()

    def _set_voice_volume(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        percent = message.get("percent")
        if not volume.is_percent(percent):
            return _error("set-voice-volume needs a percent between 0 and 100")
        # Like ducking, this only touches one stream volume: apply it directly
        # instead of asking for a full graph reconcile.
        self._manager.set_voice_volume(percent)
        return self._state()

    def _set_music_volume(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        percent = message.get("percent")
        if not volume.is_percent(percent):
            return _error("set-music-volume needs a percent between 0 and 100")
        # Stream volumes only - the background bus and the direct routes - so
        # apply them directly instead of asking for a full reconcile.
        self._manager.set_music_volume(percent)
        return self._state()

    def _set_output_mute(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        muted = message.get("muted")
        if not isinstance(muted, bool):
            return _error("set-output-mute needs a boolean muted")
        # One property on the sink itself, so it applies directly rather than
        # asking for a full graph reconcile.
        self._manager.set_output_mute(muted)
        return self._state()

    def _set_source(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        routes = self._manager.routes
        name = message.get("name")
        requested = message.get("state")
        if not isinstance(name, str) or not routes.knows(name):
            return _error("unknown source or state")
        if requested not in ("on", "off", "toggle"):
            return _error("unknown source or state")
        enabled = (
            not routes.enabled[name] if requested == "toggle" else requested == "on"
        )
        return self._state(changed=routes.set_enabled(name, enabled))

    def _set_sources(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        requested = message.get("sources")
        if not isinstance(requested, dict):
            return _error("set-sources needs a sources object")
        routes = self._manager.routes
        changed = False
        for name in list(routes.enabled):
            enabled = requested.get(name)
            # Unknown routes and non-boolean values are ignored, not coerced.
            if isinstance(enabled, bool):
                changed = routes.set_enabled(name, enabled) or changed
        return self._state(changed=changed)

    def _get_state(self, _: socket.socket, __: dict[str, Any]) -> Reply:
        return self._state()

    def _resync(self, _: socket.socket, __: dict[str, Any]) -> Reply:
        return self._state(changed=True)

    def _state(self, *, changed: bool = False) -> Reply:
        return self._manager.state_event(), changed
