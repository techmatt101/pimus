#!/usr/bin/env python3
"""Run pinned LVA with complete media-state peripheral events and a real cancel.

LVA 1.1.13 emits a playing event but not pause, stop, or natural-completion
events, and its `stop_pipeline` command only cancels a pipeline that has reached
speaking. Keep the immutable upstream checkout untouched and install these small
runtime adapters until the upstream peripheral protocol supplies them.
"""

from __future__ import annotations

import json
from enum import Enum
from typing import Any, Callable, Iterable

from aioesphomeapi.api_pb2 import MediaPlayerCommandRequest, VoiceAssistantRequest
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
            upstream_callback = done_callback

            def finished() -> None:
                emitter = getattr(self.server, "_emit", None)
                if callable(emitter):
                    emitter(SmartampMediaEvent.IDLE)
                if upstream_callback is not None:
                    upstream_callback()

            callback = finished
        yield from original_play(self, url, announcement=announcement, done_callback=callback)

    MediaPlayerEntity.play = play  # type: ignore[method-assign]


def install_pipeline_cancel_adapter() -> None:
    """Make `stop_pipeline` abort the pipeline at every phase.

    LVA 1.1.13's `satellite.stop()` only really cancels a ringing timer or a TTS
    response that is still playing. Pressed while the satellite is listening or
    waiting on Home Assistant it leaves the microphone streaming, never withdraws
    the request from HA, and emits no idle event, so the control surface goes on
    showing a live pipeline. Worse, stopping the player during the wake chime
    fires that chime's done callback, which is what starts the stream.
    """

    original_stop = VoiceSatelliteProtocol.stop

    def stop(self: VoiceSatelliteProtocol) -> None:
        player = self.state.tts_player
        ringing = self._timer_finished  # pylint: disable=protected-access
        active = self._pipeline_active  # pylint: disable=protected-access
        # A bound method compares equal to, never identical with, another
        # reference to itself.
        finishing_tts = player._done_callback == self._tts_finished  # pylint: disable=protected-access

        if not finishing_tts:
            # A pending chime callback starts audio streaming the moment the
            # player is stopped, restarting the pipeline this call cancels.
            player._done_callback = None  # pylint: disable=protected-access
        # Home Assistant can ask for the conversation to continue; a cancel must
        # not reopen the microphone.
        self._continue_conversation = False  # pylint: disable=protected-access
        self._is_streaming_audio = False  # pylint: disable=protected-access

        original_stop(self)

        if active and not ringing:
            # HA runs the pipeline until the satellite withdraws its request;
            # start=False is the abort.
            self.send_messages([VoiceAssistantRequest(start=False)])

        if not ringing and not finishing_tts:
            # Nothing was playing, so upstream's stop() emitted nothing and both
            # the ducking and the peripheral state would be left as they were.
            self._tts_url = None  # pylint: disable=protected-access
            self._tts_played = False  # pylint: disable=protected-access
            self.unduck()
            self._emit(LVAEvent.IDLE)  # pylint: disable=protected-access

    VoiceSatelliteProtocol.stop = stop  # type: ignore[method-assign]


if __name__ == "__main__":
    install_media_event_adapters()
    install_pipeline_cancel_adapter()
    lva_main.run()
