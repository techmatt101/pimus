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
import logging
import os
import time
from enum import Enum
from typing import Any, Callable, Dict, Iterable

from aioesphomeapi.api_pb2 import (
    MediaPlayerCommandRequest,
    VoiceAssistantAudio,
    VoiceAssistantRequest,
)
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

_LOGGER = logging.getLogger("smartamp")

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

# The voice detector scores one fixed 10ms frame of 16-bit mono 16kHz audio at a
# time, so the endpointer counts turn lengths in frames and never reads a clock.
ENDPOINT_FRAME_MILLISECONDS = 10
ENDPOINT_FRAME_BYTES = 160 * 2
# Above this the frame is speech; a negative score means the detector is still
# warming up and has nothing to say about the frame yet.
ENDPOINT_SPEECH_PROBABILITY = 0.5

# The events that mean the request is no longer being listened for, either
# because Home Assistant closed the stream itself or the run is over.
ENDPOINT_CLOSING_EVENTS = frozenset(
    {
        VoiceAssistantEventType.VOICE_ASSISTANT_STT_VAD_END,
        VoiceAssistantEventType.VOICE_ASSISTANT_STT_END,
        VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END,
        VoiceAssistantEventType.VOICE_ASSISTANT_ERROR,
    }
)


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


class TurnEndpointer:
    """How long a silence has to last before the request counts as finished.

    A single silence threshold cannot serve both "turn on the lamp" and a
    sentence with a pause in the middle of it, which is why Home Assistant's own
    figure is either slow or cuts people off. This one is chosen per turn from
    what has been heard so far: the short threshold applies only once enough
    speech has arrived and the speaker had got a phrase out before stopping,
    because trailing off after a single short word is what a mid-sentence pause
    sounds like. Below the minimum it never ends the turn at all, leaving a
    cough or a slammed door to Home Assistant's own detector.

    It holds nothing but frame counts, so a turn is replayable and there is no
    clock in it.
    """

    def __init__(
        self,
        silence_milliseconds: int,
        patient_silence_milliseconds: int,
        short_phrase_milliseconds: int,
        minimum_speech_milliseconds: int,
    ) -> None:
        self.silence_milliseconds = silence_milliseconds
        self.patient_silence_milliseconds = patient_silence_milliseconds
        self.short_phrase_milliseconds = short_phrase_milliseconds
        self.minimum_speech_milliseconds = minimum_speech_milliseconds
        self.speech = 0
        self.phrase = 0
        self.waited = 0
        self._run = 0

    def reset(self) -> None:
        self.speech = 0
        self.phrase = 0
        self.waited = 0
        self._run = 0

    def add(self, is_speech: bool) -> bool:
        """Add one frame, answering whether the turn ended on it."""
        if is_speech:
            self.speech += ENDPOINT_FRAME_MILLISECONDS
            self._run += ENDPOINT_FRAME_MILLISECONDS
            self.waited = 0
            return False
        if self._run:
            self.phrase = self._run
            self._run = 0
        self.waited += ENDPOINT_FRAME_MILLISECONDS
        if self.speech < self.minimum_speech_milliseconds:
            return False
        return self.waited >= self.threshold

    @property
    def threshold(self) -> int:
        if self.phrase < self.short_phrase_milliseconds:
            return self.patient_silence_milliseconds
        return self.silence_milliseconds


class LocalEndpoint:
    """The endpointer's view of the microphone stream, in whole frames.

    Audio arrives in blocks of whatever size the input device was opened with,
    so the frames the detector wants are cut from a running buffer rather than
    from each block.
    """

    def __init__(self, vad: Any, endpointer: TurnEndpointer) -> None:
        self._vad = vad
        self._buffer = bytearray()
        self.endpointer = endpointer
        self.armed = False

    def arm(self) -> None:
        self._buffer.clear()
        self.endpointer.reset()
        self.armed = True

    def disarm(self) -> None:
        self.armed = False

    def ended(self, chunk: bytes) -> bool:
        self._buffer.extend(chunk)
        while len(self._buffer) >= ENDPOINT_FRAME_BYTES:
            frame = bytes(self._buffer[:ENDPOINT_FRAME_BYTES])
            del self._buffer[:ENDPOINT_FRAME_BYTES]
            probability = self._vad.process_10ms(frame)
            if probability < 0:
                continue
            if self.endpointer.add(probability > ENDPOINT_SPEECH_PROBABILITY):
                return True
        return False


def _endpoint_milliseconds(name: str) -> int:
    value = os.environ.get(name, "")
    try:
        return max(0, int(value))
    except ValueError:
        _LOGGER.warning("Ignoring non-numeric %s=%r", name, value)
        return 0


def install_local_endpoint_adapter() -> None:
    """Let the satellite decide it has heard the whole request.

    Nothing on this machine decides when the speaker stopped: upstream streams
    the microphone from the wake word onwards and waits to be told, and Home
    Assistant tells it after a fixed run of silence chosen by the satellite's
    "finished speaking detection" setting. Deciding here instead is what allows
    both answers at once - a short silence ends a request that sounded complete,
    while Home Assistant's own figure, turned up to relaxed, stays as the
    patient backstop for the turns this declines to end.

    The protocol already distinguishes the two ways a device can stop talking.
    An audio message marked `end` closes the speech-to-text stream and lets the
    pipeline run on to the intent, where the `start=False` request the cancel
    adapter sends aborts the run outright.

    Installed last, so its event wrapper sits outside the cancel adapter's and
    still sees the end of a run that was abandoned.
    """

    endpointer = TurnEndpointer(
        silence_milliseconds=_endpoint_milliseconds("SMARTAMP_ENDPOINT_SILENCE_MS"),
        patient_silence_milliseconds=_endpoint_milliseconds("SMARTAMP_ENDPOINT_PATIENT_SILENCE_MS"),
        short_phrase_milliseconds=_endpoint_milliseconds("SMARTAMP_ENDPOINT_SHORT_PHRASE_MS"),
        minimum_speech_milliseconds=_endpoint_milliseconds("SMARTAMP_ENDPOINT_MIN_SPEECH_MS"),
    )
    if not endpointer.silence_milliseconds:
        return

    try:
        from pymicro_vad import MicroVad  # pylint: disable=import-outside-toplevel
    except ImportError:
        # Leaves Home Assistant doing the whole job, which is what this unit did
        # before local endpointing existed. Losing voice over it would be worse.
        _LOGGER.warning("No local voice detector installed; Home Assistant will end each turn")
        return

    endpoint = LocalEndpoint(MicroVad(), endpointer)

    original_handle_audio = VoiceSatelliteProtocol.handle_audio

    def handle_audio(
        self: VoiceSatelliteProtocol,
        audio_chunk: bytes,
        audio_chunk_2: bytes | None = None,
    ) -> None:
        # Upstream first: the frames that ended the turn are part of the request
        # and Home Assistant has to have them before the stream is closed.
        original_handle_audio(self, audio_chunk, audio_chunk_2)
        if not endpoint.armed or not self._is_streaming_audio:  # pylint: disable=protected-access
            return
        if self.state.muted or not endpoint.ended(audio_chunk):
            return
        endpoint.disarm()
        self._is_streaming_audio = False  # pylint: disable=protected-access
        self.send_messages([VoiceAssistantAudio(data=b"", end=True)])
        _LOGGER.debug(
            "Ended the turn locally after %dms of silence (%dms of speech, %dms final phrase)",
            endpointer.waited,
            endpointer.speech,
            endpointer.phrase,
        )

    VoiceSatelliteProtocol.handle_audio = handle_audio  # type: ignore[method-assign]

    original_handle_voice_event = VoiceSatelliteProtocol.handle_voice_event

    def handle_voice_event(
        self: VoiceSatelliteProtocol,
        event_type: VoiceAssistantEventType,
        data: Dict[str, str],
    ) -> None:
        # Armed at the speech-to-text stage rather than at the wake word: before
        # it there is no stream for an `end` to close, and the wake chime is
        # still playing into the room.
        if event_type == VoiceAssistantEventType.VOICE_ASSISTANT_STT_START:
            endpoint.arm()
        elif event_type in ENDPOINT_CLOSING_EVENTS:
            # Worth a line of its own: a turn Home Assistant ended first is the
            # one case where the thresholds are wrong and nothing else would
            # say so.
            if endpoint.armed and endpointer.speech:
                _LOGGER.debug(
                    "Home Assistant ended the turn first, after %dms of silence "
                    "(%dms of speech, %dms final phrase, needed %dms)",
                    endpointer.waited,
                    endpointer.speech,
                    endpointer.phrase,
                    endpointer.threshold,
                )
            endpoint.disarm()
        original_handle_voice_event(self, event_type, data)

    VoiceSatelliteProtocol.handle_voice_event = handle_voice_event  # type: ignore[method-assign]

    original_stop = VoiceSatelliteProtocol.stop

    def stop(self: VoiceSatelliteProtocol) -> None:
        # A cancelled request must not have its ending land in the next one.
        endpoint.disarm()
        original_stop(self)

    VoiceSatelliteProtocol.stop = stop  # type: ignore[method-assign]


if __name__ == "__main__":
    install_media_event_adapters()
    install_pipeline_cancel_adapter()
    install_stop_word_sensitivity_adapter()
    install_stop_word_scope_adapter()
    install_timer_detail_adapter()
    install_local_endpoint_adapter()
    lva_main.run()
