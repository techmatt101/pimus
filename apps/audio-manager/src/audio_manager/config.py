"""The parsed audio.json contract.

The file is generated from `roles/smartamp/templates/audio.json.j2`, which
always writes every key. The defaults here exist so a section that is switched
off stays parseable, and so a hand-written file for testing stays short.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, cast

from . import volume


DEFAULT_LATENCY_MS = 40
DEFAULT_RESYNC_SECONDS = 900.0
BACKGROUND_TARGET = "background"


@dataclass(frozen=True)
class BusConfig:
    enabled: bool
    sink_name: str
    latency_ms: int


@dataclass(frozen=True)
class BackgroundConfig(BusConfig):
    duck_volume_percent: int
    fade_ms: int
    # The trim held on the players' own streams into the bus, as a percent of
    # the music level the bridge already carries.
    client_volume_percent: int


@dataclass(frozen=True)
class VoiceBusConfig(BusConfig):
    volume_percent: int


@dataclass(frozen=True)
class EchoReferenceConfig:
    enabled: bool
    sink_match: str
    latency_ms: int


@dataclass(frozen=True)
class MicrophoneConfig:
    # Matched against the capture device's node name, description and
    # properties; the array's row in boards.yml is the usual source.
    match: str
    # The device channel published as the mono source the assistant records,
    # or None to record the device as it is. A DSP array's channels are
    # separate outputs, not a stereo pair, so this picks the one meant for
    # recognition.
    capture_channel: int | None
    echo_reference: EchoReferenceConfig


@dataclass(frozen=True)
class OutputCeilingConfig:
    """The card's hardware playback ceiling, which this daemon only reads.

    Every day-to-day gain lives in the graph; the ceiling is the amplifier's
    protection and is set once at boot from inventory. Reading it is what lets
    a control surface show the level the speakers are actually driven at
    beside the ones it can move.
    """

    card: str
    control: str

    @property
    def readable(self) -> bool:
        return bool(self.card and self.control)


@dataclass(frozen=True)
class SourceConfig:
    match: str
    enabled: bool
    latency_ms: int
    mute_when_off: bool
    requires_usb_host: bool
    target: str
    # This input's own trim, as a percent of the music level.
    volume_percent: int

    @property
    def bridges_into_background(self) -> bool:
        return self.target == BACKGROUND_TARGET


@dataclass(frozen=True)
class AudioConfig:
    output_match: str
    microphone: MicrophoneConfig
    startup_volume_percent: int
    resync_seconds: float
    # Seconds of silence before the persistent bridges are released so the
    # audio devices can suspend; 0 keeps every bridge loaded permanently.
    idle_teardown_seconds: float
    background: BackgroundConfig
    voice_bus: VoiceBusConfig
    output_ceiling: OutputCeilingConfig
    sources: dict[str, SourceConfig]

    @classmethod
    def load(cls, path: Path) -> AudioConfig:
        return cls.from_mapping(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> AudioConfig:
        background = _section(raw, "background")
        voice_bus = _section(raw, "voice_bus")
        return cls(
            output_match=str(raw.get("output_match", "")),
            microphone=_microphone(_section(raw, "microphone")),
            startup_volume_percent=volume.clamp(raw.get("startup_volume_percent", 100)),
            resync_seconds=float(raw.get("resync_seconds", DEFAULT_RESYNC_SECONDS)),
            idle_teardown_seconds=max(
                0.0, float(raw.get("idle_teardown_seconds", 0))
            ),
            background=BackgroundConfig(
                enabled=bool(background.get("enabled", False)),
                sink_name=str(background.get("sink_name", "smartamp_background")),
                latency_ms=int(background.get("latency_ms", DEFAULT_LATENCY_MS)),
                duck_volume_percent=volume.clamp(
                    background.get("duck_volume_percent", 15)
                ),
                fade_ms=max(0, int(background.get("fade_ms", 250))),
                client_volume_percent=volume.clamp(
                    background.get("client_volume_percent", 100)
                ),
            ),
            voice_bus=VoiceBusConfig(
                enabled=bool(voice_bus.get("enabled", False)),
                sink_name=str(voice_bus.get("sink_name", "smartamp_voice")),
                latency_ms=int(voice_bus.get("latency_ms", DEFAULT_LATENCY_MS)),
                volume_percent=volume.clamp(voice_bus.get("volume_percent", 100)),
            ),
            output_ceiling=OutputCeilingConfig(
                card=str(_section(raw, "output_ceiling").get("card", "")),
                control=str(_section(raw, "output_ceiling").get("control", "")),
            ),
            sources={
                name: SourceConfig(
                    match=str(source.get("match", "")),
                    enabled=bool(source.get("enabled", False)),
                    latency_ms=int(source.get("latency_ms", DEFAULT_LATENCY_MS)),
                    mute_when_off=bool(source.get("mute_when_off", False)),
                    requires_usb_host=bool(source.get("requires_usb_host", False)),
                    target=str(source.get("target", "output")),
                    volume_percent=volume.clamp(source.get("volume_percent", 100)),
                )
                for name, source in _section(raw, "sources").items()
            },
        )


def _microphone(raw: Mapping[str, Any]) -> MicrophoneConfig:
    channel = raw.get("capture_channel")
    if channel is not None and (
        isinstance(channel, bool) or not isinstance(channel, int) or channel < 0
    ):
        raise ValueError(
            "microphone.capture_channel must be a non-negative integer or null"
        )
    reference = _section(raw, "echo_reference")
    return MicrophoneConfig(
        match=str(raw.get("match", "")),
        capture_channel=channel,
        echo_reference=EchoReferenceConfig(
            enabled=bool(reference.get("enabled", False)),
            # A pattern that can never match, so a disabled reference also
            # reports no candidate sink.
            sink_match=str(reference.get("sink_match", "a^")),
            latency_ms=int(reference.get("latency_ms", DEFAULT_LATENCY_MS)),
        ),
    )


def _section(raw: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    section = raw.get(key)
    return cast(Mapping[str, Any], section) if isinstance(section, Mapping) else {}
