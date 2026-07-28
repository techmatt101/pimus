"""The parsed audio.json contract.

The file is generated from `roles/smartamp/templates/audio.json.j2`, which
always writes every key. The defaults here exist so a section that is switched
off stays parseable, and so a hand-written file for testing stays short.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

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
    # The trim held on client streams playing into the bus (Sendspin), as a
    # percent of the music level the bridge already carries.
    client_volume_percent: int


@dataclass(frozen=True)
class VoiceBusConfig(BusConfig):
    volume_percent: int


@dataclass(frozen=True)
class AecConfig:
    enabled: bool
    sink_match: str
    latency_ms: int


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
    voice_input_match: str
    voice_capture_channel: int | None
    startup_volume_percent: int
    resync_seconds: float
    aec_reference: AecConfig
    background: BackgroundConfig
    voice_bus: VoiceBusConfig
    sources: dict[str, SourceConfig]

    @classmethod
    def load(cls, path: Path) -> AudioConfig:
        return cls.from_mapping(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> AudioConfig:
        aec = _section(raw, "aec_reference")
        background = _section(raw, "background")
        voice_bus = _section(raw, "voice_bus")
        channel = raw.get("voice_capture_channel")
        return cls(
            output_match=str(raw.get("output_match", "")),
            voice_input_match=str(raw.get("voice_input_match", "")),
            voice_capture_channel=None if channel is None else int(channel),
            startup_volume_percent=volume.clamp(raw.get("startup_volume_percent", 100)),
            resync_seconds=float(raw.get("resync_seconds", DEFAULT_RESYNC_SECONDS)),
            aec_reference=AecConfig(
                enabled=bool(aec.get("enabled", False)),
                # A pattern that can never match, so a disabled reference also
                # reports no candidate sink.
                sink_match=str(aec.get("sink_match", "a^")),
                latency_ms=int(aec.get("latency_ms", DEFAULT_LATENCY_MS)),
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


def _section(raw: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    section = raw.get(key)
    return section if isinstance(section, Mapping) else {}
