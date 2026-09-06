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

from smartamp_audio import volume


DEFAULT_LATENCY_MS = 40
DEFAULT_RESYNC_SECONDS = 900.0


@dataclass(frozen=True)
class BusConfig:
    enabled: bool
    sink_name: str
    latency_ms: int


@dataclass(frozen=True)
class MusicBusConfig(BusConfig):
    # Whether the assistant dips this bus while it talks. The bus is the music
    # path whatever the answer, because its sink volume is the music level's
    # public face; ducking is only something that happens to it.
    ducking_enabled: bool
    duck_volume_percent: int
    fade_ms: int


@dataclass(frozen=True)
class VoiceBusConfig(BusConfig):
    volume_percent: int


@dataclass(frozen=True)
class EchoReferenceConfig:
    """The output's monitor, looped into whichever sink matches.

    What the assistant records is not here: the voice capture source is
    PipeWire's own configuration, deployed beside this daemon rather than
    built by it.
    """

    enabled: bool
    # Matched against the reference sink's node name, description and
    # properties; the array's row in boards.yml is the usual source.
    sink_match: str
    latency_ms: int


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
    """One channel of the mixer: a name inventory gave a music input.

    The daemon never learns how the input reaches the bus - a stream is this
    source's because its `smartamp.source` property says so. All it holds is
    the input's trim, and, for an input the deck can switch, its toggle.
    """

    # This input's own trim, as a percent of the music level.
    volume_percent: int
    # The resting position of the toggle, or None for an input with nothing
    # to switch, such as the players that stream straight into the bus.
    enabled: bool | None

    @property
    def switchable(self) -> bool:
        return self.enabled is not None


@dataclass(frozen=True)
class AudioConfig:
    output_match: str
    echo_reference: EchoReferenceConfig
    startup_volume_percent: int
    resync_seconds: float
    # Seconds of silence before the persistent bridges are released so the
    # audio devices can suspend; 0 keeps every bridge loaded permanently.
    idle_teardown_seconds: float
    music_bus: MusicBusConfig
    voice_bus: VoiceBusConfig
    output_ceiling: OutputCeilingConfig
    # The source a bus stream with no `smartamp.source` tag belongs to: the
    # players pointed at the bus by their own units, and anything playing at
    # the default sink. The daemon names no product; inventory calls it what
    # it is on this unit.
    default_source: str
    sources: dict[str, SourceConfig]

    @classmethod
    def load(cls, path: Path) -> AudioConfig:
        return cls.from_mapping(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> AudioConfig:
        music_bus = _section(raw, "music_bus")
        voice_bus = _section(raw, "voice_bus")
        return cls(
            output_match=str(raw.get("output_match", "")),
            echo_reference=_echo_reference(_section(raw, "echo_reference")),
            startup_volume_percent=volume.clamp(raw.get("startup_volume_percent", 100)),
            resync_seconds=float(raw.get("resync_seconds", DEFAULT_RESYNC_SECONDS)),
            idle_teardown_seconds=max(
                0.0, float(raw.get("idle_teardown_seconds", 0))
            ),
            music_bus=MusicBusConfig(
                enabled=bool(music_bus.get("enabled", False)),
                sink_name=str(music_bus.get("sink_name", "smartamp_music")),
                latency_ms=int(music_bus.get("latency_ms", DEFAULT_LATENCY_MS)),
                ducking_enabled=bool(music_bus.get("ducking_enabled", False)),
                duck_volume_percent=volume.clamp(
                    music_bus.get("duck_volume_percent", 15)
                ),
                fade_ms=max(0, int(music_bus.get("fade_ms", 250))),
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
            default_source=str(raw.get("default_source", "players")),
            sources={
                str(name): _source(source)
                for name, source in _section(raw, "sources").items()
            },
        )


def _source(raw: object) -> SourceConfig:
    section: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw) if isinstance(raw, Mapping) else {}
    )
    return SourceConfig(
        volume_percent=volume.clamp(section.get("volume_percent", 100)),
        enabled=bool(section["enabled"]) if "enabled" in section else None,
    )


def _echo_reference(raw: Mapping[str, Any]) -> EchoReferenceConfig:
    return EchoReferenceConfig(
        enabled=bool(raw.get("enabled", False)),
        # A pattern that can never match, so a disabled reference also
        # reports no candidate sink.
        sink_match=str(raw.get("sink_match", "a^")),
        latency_ms=int(raw.get("latency_ms", DEFAULT_LATENCY_MS)),
    )


def _section(raw: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    section = raw.get(key)
    return cast(Mapping[str, Any], section) if isinstance(section, Mapping) else {}
