"""The parsed audio-inputs.json contract.

The file is generated from `roles/smartamp/templates/audio-inputs.json.j2`,
which lists only the inputs this unit's hardware has, each under the source
name the audio manager mixes it as.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, cast


DEFAULT_LATENCY_MS = 40


@dataclass(frozen=True)
class InputConfig:
    # Which `Input` class runs it; see inputs/__init__.py for the table.
    kind: str
    # Matched against the capture node's name, description and properties.
    match: str
    latency_ms: int


@dataclass(frozen=True)
class InputsConfig:
    # The music bus every input plays into, and the manager's status file,
    # which says when that bus is published and when the graph is idle.
    sink_name: str
    audio_status: Path
    inputs: dict[str, InputConfig]

    @classmethod
    def load(cls, path: Path) -> InputsConfig:
        return cls.from_mapping(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> InputsConfig:
        latency_ms = max(1, int(raw.get("latency_ms", DEFAULT_LATENCY_MS)))
        inputs = raw.get("inputs")
        entries: Mapping[str, Any] = (
            cast(Mapping[str, Any], inputs) if isinstance(inputs, Mapping) else {}
        )
        return cls(
            sink_name=str(raw.get("sink_name", "smartamp_music")),
            audio_status=Path(raw["audio_status"]),
            inputs={
                str(name): _input(entry, latency_ms) for name, entry in entries.items()
            },
        )


def _input(raw: object, latency_ms: int) -> InputConfig:
    section: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw) if isinstance(raw, Mapping) else {}
    )
    return InputConfig(
        kind=str(section.get("kind", "")),
        match=str(section.get("match", "")),
        latency_ms=max(1, int(section.get("latency_ms", latency_ms))),
    )
