"""The USB client's own deployment configuration."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from smartamp_audio import volume


@dataclass(frozen=True)
class UsbConfig:
    source_match: str
    sink_name: str
    audio_status: Path
    enabled: bool
    volume_percent: int
    latency_ms: int

    @classmethod
    def load(cls, path: Path) -> UsbConfig:
        return cls.from_mapping(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> UsbConfig:
        return cls(
            source_match=str(raw.get("source_match", "UAC2Gadget")),
            sink_name=str(raw.get("sink_name", "smartamp_background")),
            audio_status=Path(raw["audio_status"]),
            enabled=bool(raw.get("enabled", False)),
            volume_percent=volume.clamp(raw.get("volume_percent", 100)),
            latency_ms=max(1, int(raw.get("latency_ms", 40))),
        )
