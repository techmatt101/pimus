#!/usr/bin/env python3
"""Run pinned LVA with complete media-state peripheral events and a real cancel.

LVA 1.1.13 emits a playing event but not pause, stop, or natural-completion
events, its `stop_pipeline` command only cancels a pipeline that has reached
speaking, and its stop word is only listened for over a spoken reply. Keep the
immutable upstream checkout untouched and install these small runtime adapters
until the upstream peripheral protocol supplies them.
"""

from __future__ import annotations

import json
import time
from enum import Enum
from typing import Any, Callable, Dict, Iterable

from aioesphomeapi.api_pb2 import MediaPlayerCommandRequest, VoiceAssistantRequest
from aioesphomeapi.model import (
    MediaPlayerCommand,
    VoiceAssistantEventType,
    VoiceAssistantTimerEventType,
)

from linux_voice_assistant import __main__ as lva_main
from linux_voice_assistant.entity import MediaPlayerEntity
from linux_voice_assistant.models import ServerState
from linux_voice_assistant.peripheral_api import LVACommand, LVAEvent, PeripheralAPIServer
from linux_voice_assistant.satellite import VoiceSatelliteProtocol

# Peripheral events that say a voice pipeline is live.
LIVE_PIPELINE_EVENTS = frozenset(
    {
        LVAEvent.WAKE_WORD_DETECTED,
        LVAEvent.LISTENING,
        LVAEvent.THINKING,
        LVAEvent.TTS_SPEAKING,
        LVAEvent.TIMER_RINGING,
    }
)

# The phases a shouted "stop" abandons. Listening is deliberately absent: the
# words being listened for are the request itself, and "stop the music" would
# cancel that request instead of running it.
STOP_WORD_PHASES = frozenset({LVAEvent.THINKING, LVAEvent.TTS_SPEAKING, LVAEvent.TIMER_RINGING})


class SmartampMediaEvent(str, Enum):
    """Events understood by the Smart Amp controller but absent in LVA 1.1.13."""

    PAUSED = "media_player_paused"
    IDLE = "media_player_idle"


class SmartampTimerEvent(str, Enum):
    """A cancelled timer, which upstream reports only as a general idle."""

    CANCELLED = "timer_cancelled"


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

    A cancel also has to outlive the moment it happens. Home Assistant may
    already be running the intent when the request is withdrawn, and upstream
    applies whatever that run reports next, so a reply generated a moment too
    late would start speaking after the amp had gone quiet. The cancel therefore
    holds until a new pipeline begins, and the ending it emits is marked, which
    is what lets the controller drop the ring and the duck at once instead of
    holding them for the output buffer a reply that ran out would still have.
    """

    original_stop = VoiceSatelliteProtocol.stop

    def stop(self: VoiceSatelliteProtocol) -> None:
        # Set before anything is torn down: this is what marks the endings the
        # teardown emits, and what drops the abandoned run's remaining events.
        self._smartamp_cancelled = True
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

    original_handle_voice_event = VoiceSatelliteProtocol.handle_voice_event

    def handle_voice_event(
        self: VoiceSatelliteProtocol,
        event_type: VoiceAssistantEventType,
        data: Dict[str, str],
    ) -> None:
        if event_type == VoiceAssistantEventType.VOICE_ASSISTANT_RUN_START:
            self._smartamp_cancelled = False
        elif getattr(self, "_smartamp_cancelled", False):
            # The run this belongs to was cancelled; its reply must not arrive.
            return
        original_handle_voice_event(self, event_type, data)

    VoiceSatelliteProtocol.handle_voice_event = handle_voice_event  # type: ignore[method-assign]

    original_emit = VoiceSatelliteProtocol._emit  # pylint: disable=protected-access

    def emit(
        self: VoiceSatelliteProtocol,
        event: LVAEvent | SmartampTimerEvent,
        data: dict[str, Any] | None = None,
    ) -> None:
        if event in LIVE_PIPELINE_EVENTS:
            # A pipeline is running again, so the last cancel is spent. An
            # announcement arrives this way too, without a run of its own.
            self._smartamp_cancelled = False
        elif getattr(self, "_smartamp_cancelled", False) and event in (
            LVAEvent.TTS_FINISHED,
            LVAEvent.IDLE,
        ):
            data = {**(data or {}), "cancelled": True}
        original_emit(self, event, data)  # type: ignore[arg-type]

    VoiceSatelliteProtocol._emit = emit  # type: ignore[method-assign]  # pylint: disable=protected-access


def install_stop_word_scope_adapter() -> None:
    """Listen for the stop word while thinking, not only over a spoken reply.

    LVA detects the stop word on every audio chunk, but only acts on it while
    the model's id sits in `active_wake_words`, and upstream only puts it there
    for a spoken reply, an announcement, and a ringing timer. An assistant
    waiting on Home Assistant is therefore the one phase where "stop" is heard,
    recognised, and then thrown away, leaving the deck as the only way out of a
    request that is taking too long or was never wanted. Arming per phase also
    re-arms after Home Assistant rebuilds the active set from a configuration
    change, which upstream's one-shot add does not survive.
    """

    original_emit = VoiceSatelliteProtocol._emit  # pylint: disable=protected-access

    def emit(
        self: VoiceSatelliteProtocol,
        event: LVAEvent | SmartampTimerEvent,
        data: dict[str, Any] | None = None,
    ) -> None:
        if event in STOP_WORD_PHASES:
            self.state.active_wake_words.add(self.state.stop_word.id)
        elif event in (LVAEvent.LISTENING, LVAEvent.IDLE, LVAEvent.PIPELINE_ERROR):
            self.state.active_wake_words.discard(self.state.stop_word.id)
        original_emit(self, event, data)  # type: ignore[arg-type]

    VoiceSatelliteProtocol._emit = emit  # type: ignore[method-assign]  # pylint: disable=protected-access


def install_stop_word_sensitivity_adapter() -> None:
    """Restore the saved stop-word sensitivity at startup.

    Upstream writes the Home Assistant slider's value into its preferences file
    but never reads it back (its own TODO), so every restart drops the stop word
    to the 0.5 default while the entity still shows the tuned figure. The
    threshold is read from server state on each chunk, so seeding it before the
    satellite builds its entities is enough.
    """

    original_init = VoiceSatelliteProtocol.__init__

    def init(self: VoiceSatelliteProtocol, state: ServerState) -> None:
        saved = state.preferences.stop_word_sensitivity
        if saved is not None:
            state.stop_word_threshold = float(saved)
        original_init(self, state)

    VoiceSatelliteProtocol.__init__ = init  # type: ignore[method-assign]


def install_timer_detail_adapter() -> None:
    """Give peripheral timer events the facts needed to draw a countdown.

    Upstream forwards a timer's id, name, total and seconds-left, but drops the
    `is_active` flag, so a paused timer is indistinguishable from a running one
    and a control surface counting down locally would keep counting. It also
    reports a cancelled timer as a plain idle, which is the same event a
    finished voice pipeline emits, leaving a peripheral unable to tell "your
    timer is gone" from "I have stopped talking". Emitting the instant of the
    event alongside keeps a countdown honest across a peripheral reconnect,
    when LVA replays the state it cached rather than a fresh reading.
    """

    original_emit = VoiceSatelliteProtocol._emit  # pylint: disable=protected-access

    def emit(
        self: VoiceSatelliteProtocol,
        event: LVAEvent | SmartampTimerEvent,
        data: dict[str, Any] | None = None,
    ) -> None:
        if data is not None and "seconds_left" in data:
            data = {
                **data,
                "is_active": getattr(self, "_smartamp_timer_active", True),
                "emitted_at": time.time(),
            }
        original_emit(self, event, data)  # type: ignore[arg-type]

    VoiceSatelliteProtocol._emit = emit  # type: ignore[method-assign]  # pylint: disable=protected-access

    original_handle_timer_event = VoiceSatelliteProtocol.handle_timer_event

    def handle_timer_event(
        self: VoiceSatelliteProtocol,
        event_type: VoiceAssistantTimerEventType,
        msg: Any,
    ) -> None:
        self._smartamp_timer_active = msg.is_active  # pylint: disable=protected-access
        if event_type == VoiceAssistantTimerEventType.VOICE_ASSISTANT_TIMER_CANCELLED:
            # Ahead of the idle upstream emits for the same event, so a client
            # applying them in order ends up with no timer either way.
            self._emit(SmartampTimerEvent.CANCELLED)  # type: ignore[arg-type]  # pylint: disable=protected-access
        original_handle_timer_event(self, event_type, msg)

    VoiceSatelliteProtocol.handle_timer_event = handle_timer_event  # type: ignore[method-assign]


if __name__ == "__main__":
    install_media_event_adapters()
    install_pipeline_cancel_adapter()
    install_stop_word_sensitivity_adapter()
    install_stop_word_scope_adapter()
    install_timer_detail_adapter()
    lva_main.run()
