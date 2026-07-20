#!/usr/bin/env python3
"""Run pinned LVA with complete media-state peripheral events.

LVA 1.1.13 emits a playing event but not pause, stop, or natural-completion
events. Keep the immutable upstream checkout untouched and install these small
runtime adapters until the upstream peripheral protocol supplies them.
"""

from __future__ import annotations

import json
from enum import Enum
from typing import Any, Callable, Iterable

from aioesphomeapi.api_pb2 import MediaPlayerCommandRequest
from aioesphomeapi.model import MediaPlayerCommand

from linux_voice_assistant import __main__ as lva_main
from linux_voice_assistant.entity import MediaPlayerEntity
from linux_voice_assistant.peripheral_api import LVACommand, LVAEvent, PeripheralAPIServer
from linux_voice_assistant.satellite import VoiceSatelliteProtocol


class SmartampMediaEvent(str, Enum):
    """Events understood by the Smart Amp controller but absent in LVA 1.1.13."""

    PAUSED = "media_player_paused"
    IDLE = "media_player_idle"


def event_for_command(command: MediaPlayerCommand) -> LVAEvent | SmartampMediaEvent | None:
    if command == MediaPlayerCommand.PLAY:
        return LVAEvent.MEDIA_PLAYER_PLAYING
    if command == MediaPlayerCommand.PAUSE:
        return SmartampMediaEvent.PAUSED
    if command == MediaPlayerCommand.STOP:
        return SmartampMediaEvent.IDLE
    return None


def install_media_event_adapters() -> None:
    original_emit_event = PeripheralAPIServer.emit_event

    async def emit_event(
        self: PeripheralAPIServer,
        event: LVAEvent | SmartampMediaEvent,
        data: dict[str, Any] | None = None,
    ) -> None:
        # Upstream's state cache only recognises its own enum. Cache the added
        # states here so a reconnecting controller receives the correct replay.
        if isinstance(event, SmartampMediaEvent):
            self._current_state = event  # type: ignore[assignment]  # pylint: disable=protected-access
            self._current_state_data = data or None  # pylint: disable=protected-access
        await original_emit_event(self, event, data)  # type: ignore[arg-type]

    PeripheralAPIServer.emit_event = emit_event  # type: ignore[method-assign]

    original_dispatch = PeripheralAPIServer._dispatch_command  # pylint: disable=protected-access

    async def dispatch(self: PeripheralAPIServer, raw: str) -> None:
        await original_dispatch(self, raw)
        try:
            command = LVACommand(json.loads(raw).get("command", ""))
        except (AttributeError, json.JSONDecodeError, ValueError):
            return
        event = {
            LVACommand.RESUME_MEDIA_PLAYER: LVAEvent.MEDIA_PLAYER_PLAYING,
            LVACommand.PAUSE_MEDIA_PLAYER: SmartampMediaEvent.PAUSED,
            LVACommand.STOP_MEDIA_PLAYER: SmartampMediaEvent.IDLE,
        }.get(command)
        if event is not None:
            await self.emit_event(event)  # type: ignore[arg-type]

    PeripheralAPIServer._dispatch_command = dispatch  # type: ignore[method-assign]  # pylint: disable=protected-access

    original_handle_message = VoiceSatelliteProtocol.handle_message

    def handle_message(
        self: VoiceSatelliteProtocol,
        message: Any,
    ) -> Iterable[Any]:
        yield from original_handle_message(self, message)
        if not isinstance(message, MediaPlayerCommandRequest) or not message.has_command:
            return
        try:
            event = event_for_command(MediaPlayerCommand(message.command))
        except ValueError:
            return
        if event is not None:
            self._emit(event)  # type: ignore[arg-type]  # pylint: disable=protected-access

    VoiceSatelliteProtocol.handle_message = handle_message  # type: ignore[method-assign]

    original_play = MediaPlayerEntity.play

    def play(
        self: MediaPlayerEntity,
        url: str | list[str],
        announcement: bool = False,
        done_callback: Callable[[], None] | None = None,
    ) -> Iterable[Any]:
        callback = done_callback
        if not announcement:
            def finished() -> None:
                emitter = getattr(self.server, "_emit", None)
                if callable(emitter):
                    emitter(SmartampMediaEvent.IDLE)
                if callback is not None:
                    callback()

            callback = finished
        yield from original_play(self, url, announcement=announcement, done_callback=callback)

    MediaPlayerEntity.play = play  # type: ignore[method-assign]


if __name__ == "__main__":
    install_media_event_adapters()
    lva_main.run()
