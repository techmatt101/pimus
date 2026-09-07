"""The control-socket protocol: one handler per command, validation included."""

from __future__ import annotations

import json
import logging
import socket
from typing import TYPE_CHECKING, Any, Callable, cast

from smartamp_audio import volume
from .leases import Leases


if TYPE_CHECKING:
    from ..daemon import AudioManager


LOG = logging.getLogger(__name__)

Reply = tuple[dict[str, Any], bool]

# The lowest ceiling the socket may set. The control's percent scale is
# logarithmic, about a decibel a point, so 70 is already some 30 dB down and
# anything lower is a dial that can silence the amplifier rather than trim it.
OUTPUT_CEILING_FLOOR_PERCENT = 70


def _error(message: str) -> Reply:
    return {"event": "error", "error": message}, False


class CommandHandler:
    """Validates socket commands and applies them to the manager.

    The commands that outlast their reply - ducking and metering - are held
    in the manager's leases against the requesting connection, and released
    here when it goes.
    """

    def __init__(self, manager: AudioManager, leases: Leases) -> None:
        self._manager = manager
        self._leases = leases
        self._handlers: dict[str, Callable[[socket.socket, dict[str, Any]], Reply]] = {
            "set-duck": self._set_duck,
            "set-voice-meter": self._set_voice_meter,
            "set-voice-volume": self._set_voice_volume,
            "set-music-volume": self._set_music_volume,
            "set-music-mute": self._set_music_mute,
            "set-output-ceiling": self._set_output_ceiling,
            "set-source-trim": self._set_source_trim,
            "set-source-state": self._set_source_state,
            "get-state": self._get_state,
            "force-idle": self._force_idle,
            "resync": self._resync,
        }

    def apply(self, connection: socket.socket, message: Any) -> Reply:
        if not isinstance(message, dict):
            return _error("message must be a JSON object")
        LOG.debug("socket command: %s", json.dumps(message))
        command = cast(dict[str, Any], message).get("command")
        if not isinstance(command, str):
            return _error("command must be a string")
        handler = self._handlers.get(command)
        if handler is None:
            return _error(f"unknown command {command!r}")
        return handler(connection, cast(dict[str, Any], message))

    def client_gone(self, connection: socket.socket) -> None:
        released = self._leases.release(connection)
        if not self._manager.running:
            return
        if released.meter:
            self._manager.apply_voice_meter()
        if released.duck:
            self._manager.safe_apply_ducking()

    def _set_duck(self, connection: socket.socket, message: dict[str, Any]) -> Reply:
        active = message.get("active")
        if not isinstance(active, bool):
            return _error("set-duck needs a boolean active")
        self._leases.request_duck(connection, active)
        if active:
            # A duck request opens a voice session seconds before its first
            # TTS stream exists — the earliest moment an idle teardown can
            # start rebuilding, so the reply plays through a ready bridge.
            self._manager.notice_voice_activity()
        # Ducking only touches the music bridge's volume, so apply it
        # directly instead of asking for a full graph reconcile.
        self._manager.safe_apply_ducking()
        return self._state()

    def _force_idle(self, connection: socket.socket, message: dict[str, Any]) -> Reply:
        # A one-shot, not a lease: nothing to release when the socket closes.
        self._manager.force_idle()
        return self._state()

    def _set_voice_meter(
        self, connection: socket.socket, message: dict[str, Any]
    ) -> Reply:
        active = message.get("active")
        if not isinstance(active, bool):
            return _error("set-voice-meter needs a boolean active")
        self._leases.request_meter(connection, active)
        if active:
            # A meter request marks a live voice session, exactly as a duck
            # request does.
            self._manager.notice_voice_activity()
        # Metering only starts or stops a capture of the voice monitor; it
        # changes nothing about the graph the daemon reconciles.
        self._manager.apply_voice_meter()
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
        # Stream volumes only - the music bus and the direct clients - so
        # apply them directly instead of asking for a full reconcile.
        self._manager.set_music_volume(percent)
        return self._state()

    def _set_music_mute(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        muted = message.get("muted")
        if not isinstance(muted, bool):
            return _error("set-music-mute needs a boolean muted")
        # The same stream gains a music volume moves, so it applies directly too.
        self._manager.set_music_mute(muted)
        return self._state()

    def _set_output_ceiling(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        if not self._manager.ceiling.readable:
            return _error("this unit has no output ceiling to set")
        percent = message.get("percent")
        floor = OUTPUT_CEILING_FLOOR_PERCENT
        if not volume.is_percent(percent) or percent < floor:
            return _error(f"set-output-ceiling needs a percent between {floor} and 100")
        # The hardware control under every graph gain, so nothing in the graph
        # needs reconciling; the reply carries the level the card reads back.
        self._manager.set_output_ceiling(round(percent))
        return self._state()

    def _set_source_trim(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        name = message.get("name")
        percent = message.get("percent")
        if not isinstance(name, str) or not self._manager.mixer.knows(name):
            return _error("unknown source trim")
        if not volume.is_percent(percent):
            return _error("set-source-trim needs a percent between 0 and 100")
        # One stream's own gain, exactly as a music level move is, so it
        # applies directly rather than asking for a full reconcile.
        self._manager.set_source_trim(name, percent)
        return self._state()

    def _set_source_state(self, _: socket.socket, message: dict[str, Any]) -> Reply:
        mixer = self._manager.mixer
        name = message.get("name")
        requested = message.get("state")
        if not isinstance(name, str) or not mixer.switchable(name):
            return _error("unknown source or state")
        if requested not in ("on", "off", "toggle"):
            return _error("unknown source or state")
        enabled = (
            not mixer.enabled[name] if requested == "toggle" else requested == "on"
        )
        return self._state(changed=self._manager.set_source_enabled(name, enabled))

    def _get_state(self, _: socket.socket, __: dict[str, Any]) -> Reply:
        return self._state()

    def _resync(self, _: socket.socket, __: dict[str, Any]) -> Reply:
        return self._state(changed=True)

    def _state(self, *, changed: bool = False) -> Reply:
        return self._manager.state_event(), changed
