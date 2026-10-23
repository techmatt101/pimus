"""Requested audio settings, saved once on clean exit and restored at startup."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar, cast

from smartamp_audio import status, volume
from .config import AudioConfig, SourceConfig


LOG = logging.getLogger(__name__)


# Version 1 saved no defaults beside its settings, so it cannot tell a level
# the deck moved from one inventory has since moved.
VERSION = 2

T = TypeVar("T")


@dataclass(frozen=True)
class SavedState:
    """The settings a clean exit leaves behind.

    Each is saved beside the inventory default it was saved under. A provision
    that moves a default restarts the daemon, and that exit saves the old
    level; restoring it would undo the provision until the next reboot. A
    setting whose default has moved since takes the new default instead, and
    every other one comes back as it was left.
    """

    music_volume: int
    music_muted: bool
    voice_volume: int
    sources: dict[str, SourceConfig]

    @classmethod
    def defaults(cls, config: AudioConfig) -> SavedState:
        return cls(
            config.startup_volume_percent, False, config.voice_bus.volume_percent,
            config.sources,
        )

    @classmethod
    def load(cls, config: AudioConfig, path: Path | None) -> SavedState:
        defaults = cls.defaults(config)
        if path is None:
            return defaults
        try:
            raw = _mapping(json.loads(path.read_text(encoding="utf-8")))
            if type(raw.get("version")) is not int or raw["version"] != VERSION:
                raise ValueError("unsupported state version")
            saved = cls._parse(raw, defaults)
            saved_under = cls._parse(_mapping(raw.get("defaults")), defaults)
            return saved._unless_moved(saved_under, defaults)
        except FileNotFoundError:
            return defaults
        except (OSError, ValueError, RecursionError) as error:
            LOG.warning("Cannot restore audio state from %s; using defaults: %s", path, error)
            return defaults

    def save(self, path: Path, defaults: SavedState) -> None:
        status.write(path, {
            "version": VERSION,
            **self._document(),
            "defaults": defaults._document(),
        })

    @classmethod
    def _parse(cls, raw: dict[str, Any], defaults: SavedState) -> SavedState:
        # Shaped by the current configuration: a source inventory has dropped
        # is forgotten, and one it has added starts at its default.
        sources = _mapping(raw.get("sources"))
        return cls(
            _percent(raw.get("music_volume")),
            _boolean(raw.get("music_muted")),
            _percent(raw.get("voice_volume")),
            {
                name: _source(sources.get(name, {}), source)
                for name, source in defaults.sources.items()
            },
        )

    def _unless_moved(self, saved_under: SavedState, defaults: SavedState) -> SavedState:
        return SavedState(
            _kept(self.music_volume, saved_under.music_volume, defaults.music_volume),
            _kept(self.music_muted, saved_under.music_muted, defaults.music_muted),
            _kept(self.voice_volume, saved_under.voice_volume, defaults.voice_volume),
            {
                name: SourceConfig(
                    _kept(
                        source.volume_percent,
                        saved_under.sources[name].volume_percent,
                        defaults.sources[name].volume_percent,
                    ),
                    _kept(
                        source.enabled,
                        saved_under.sources[name].enabled,
                        defaults.sources[name].enabled,
                    ),
                )
                for name, source in self.sources.items()
            },
        )

    def _document(self) -> dict[str, Any]:
        return {
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
        }


def _kept(saved: T, saved_under: T, default: T) -> T:
    """A saved setting, unless inventory has moved its default since."""
    return saved if saved_under == default else default


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
