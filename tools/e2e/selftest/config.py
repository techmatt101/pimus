"""The parsed selftest.json contract.

The file is generated from `roles/smartamp/templates/selftest.json.j2` from
the same inventory the daemons are configured from, so the suite knows which
features this unit has without rediscovering them: a feature the unit lacks
is skipped by name rather than failing as missing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, cast


# The lowest ceiling the manager accepts; also the level the near-silent
# tiers park the amplifier at, some 30 dB under the inventory default.
SILENT_CEILING_PERCENT = 70


@dataclass(frozen=True)
class SourceConfig:
    name: str
    switchable: bool


@dataclass(frozen=True)
class VoiceConfig:
    enabled: bool
    input_name: str
    capture_name: str | None
    ducking: bool


@dataclass(frozen=True)
class CeilingConfig:
    card: str
    control: str
    percent: int


@dataclass(frozen=True)
class UsbDevice:
    label: str
    usb_id: str


@dataclass(frozen=True)
class RespeakerConfig(UsbDevice):
    host_control: bool
    led: bool


@dataclass(frozen=True)
class AcousticConfig:
    # The music level the audible tier plays at, and how far the array's ASR
    # output must rise over the quiet room for the speaker to count as heard.
    music_volume: int
    noise_seconds: float
    min_rise_db: float


@dataclass(frozen=True)
class SelftestConfig:
    service_user: str
    uid: int
    runtime_dir: Path
    socket: Path
    status: Path
    inputs_status: Path | None
    output_match: str
    music_sink: str
    voice_sink: str
    duck_volume_percent: int
    idle_teardown: bool
    ceiling: CeilingConfig | None
    sources: dict[str, SourceConfig]
    voice: VoiceConfig
    aec_reference: bool
    respeaker: RespeakerConfig | None
    streamdeck: UsbDevice | None
    usb_ports: list[str]
    services: list[str]
    controller: bool
    home_assistant: bool
    acoustic: AcousticConfig

    @classmethod
    def load(cls, path: Path) -> SelftestConfig:
        with path.open(encoding="utf-8") as handle:
            raw: object = json.load(handle)
        if not isinstance(raw, dict):
            raise ValueError(f"{path} must hold a JSON object")
        return cls.from_mapping(cast(Mapping[str, Any], raw))

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> SelftestConfig:
        runtime_dir = Path(str(data.get("runtime_dir", "")))
        inputs_status = data.get("inputs_status")
        ceiling = _section(data.get("ceiling"))
        respeaker = _section(data.get("respeaker"))
        streamdeck = _section(data.get("streamdeck"))
        voice = _section(data.get("voice")) or {}
        acoustic = _section(data.get("acoustic")) or {}
        capture_name = voice.get("capture_name")
        return cls(
            service_user=str(data.get("service_user", "smartamp")),
            uid=int(data.get("uid", 0)),
            runtime_dir=runtime_dir,
            socket=Path(str(data.get("socket", runtime_dir / "smartamp-audio.sock"))),
            status=Path(
                str(data.get("status", runtime_dir / "smartamp-audio-status.json"))
            ),
            inputs_status=Path(str(inputs_status)) if inputs_status else None,
            output_match=str(data.get("output_match", "")),
            music_sink=str(data.get("music_sink", "smartamp_music")),
            voice_sink=str(data.get("voice_sink", "smartamp_voice")),
            duck_volume_percent=int(data.get("duck_volume_percent", 15)),
            idle_teardown=bool(data.get("idle_teardown", False)),
            ceiling=(
                CeilingConfig(
                    card=str(ceiling.get("card", "")),
                    control=str(ceiling.get("control", "Digital")),
                    percent=int(ceiling.get("percent", 90)),
                )
                if ceiling and ceiling.get("card")
                else None
            ),
            sources={
                str(name): SourceConfig(
                    name=str(name), switchable=bool(_mapping(entry).get("switchable"))
                )
                for name, entry in _mapping(data.get("sources")).items()
            },
            voice=VoiceConfig(
                enabled=bool(voice.get("enabled", False)),
                input_name=str(voice.get("input_name", "smartamp_voice_input")),
                capture_name=str(capture_name) if capture_name else None,
                ducking=bool(voice.get("ducking", False)),
            ),
            aec_reference=bool(data.get("aec_reference", False)),
            respeaker=(
                RespeakerConfig(
                    label=str(respeaker.get("label", "ReSpeaker")),
                    usb_id=str(respeaker.get("usb_id", "")),
                    host_control=bool(respeaker.get("host_control", False)),
                    led=bool(respeaker.get("led", False)),
                )
                if respeaker
                else None
            ),
            streamdeck=(
                UsbDevice(
                    label=str(streamdeck.get("label", "Stream Deck")),
                    usb_id=str(streamdeck.get("usb_id", "")),
                )
                if streamdeck
                else None
            ),
            usb_ports=[str(port) for port in _strings(data.get("usb_ports"))],
            services=[str(unit) for unit in _strings(data.get("services"))],
            controller=bool(data.get("controller", False)),
            home_assistant=bool(data.get("home_assistant", False)),
            acoustic=AcousticConfig(
                music_volume=int(acoustic.get("music_volume", 40)),
                noise_seconds=float(acoustic.get("noise_seconds", 5.0)),
                min_rise_db=float(acoustic.get("min_rise_db", 6.0)),
            ),
        )

    @property
    def switchable_sources(self) -> list[str]:
        return [name for name, source in self.sources.items() if source.switchable]


def _section(value: object) -> dict[str, Any] | None:
    return cast(dict[str, Any], value) if isinstance(value, dict) else None


def _mapping(value: object) -> dict[str, Any]:
    return _section(value) or {}


def _strings(value: object) -> list[object]:
    return cast(list[object], value) if isinstance(value, list) else []
