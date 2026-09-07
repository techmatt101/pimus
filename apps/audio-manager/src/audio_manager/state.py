"""Requested audio settings, saved once on clean exit and restored at startup."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from smartamp_audio import status, volume
from .config import AudioConfig, SourceConfig


LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class SavedState:
    music_volume: int
    music_muted: bool
    voice_volume: int
    sources: dict[str, SourceConfig]

    @classmethod
    def load(cls, config: AudioConfig, path: Path | None) -> SavedState:
        defaults = cls(
            config.startup_volume_percent, False, config.voice_bus.volume_percent,
            config.sources,
        )
        if path is None:
            return defaults
        try:
            raw = _mapping(json.loads(path.read_text(encoding="utf-8")))
            if type(raw.get("version")) is not int or raw["version"] != 1:
                raise ValueError("unsupported state version")
            sources = _mapping(raw.get("sources"))
            return cls(
                _percent(raw.get("music_volume")),
                _boolean(raw.get("music_muted")),
                _percent(raw.get("voice_volume")),
                {
                    name: _source(sources.get(name, {}), source)
                    for name, source in config.sources.items()
                },
            )
        except FileNotFoundError:
            return defaults
        except (OSError, ValueError, RecursionError) as error:
            LOG.warning("Cannot restore audio state from %s; using defaults: %s", path, error)
            return defaults

    def save(self, path: Path) -> None:
        status.write(path, {
            "version": 1,
            "music_volume": self.music_volume,
            "music_muted": self.music_muted,
            "voice_volume": self.voice_volume,
            "sources": {
                name: {
                    "trim": source.volume_percent,
                    **({"enabled": source.enabled} if source.switchable else {}),
                }
                for name, source in self.sources.items()
            },
        })


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("expected an object")
    return cast(dict[str, Any], value)


def _percent(value: Any) -> int:
    if not volume.is_percent(value):
        raise ValueError("expected a level between 0 and 100")
    return volume.clamp(value)


def _boolean(value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValueError("expected a boolean")
    return value


def _source(value: Any, default: SourceConfig) -> SourceConfig:
    raw = _mapping(value)
    return SourceConfig(
        _percent(raw.get("trim", default.volume_percent)),
        _boolean(raw.get("enabled", default.enabled)) if default.switchable else None,
    )
