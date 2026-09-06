"""The music players' bus, dipped while the voice assistant is talking."""

from __future__ import annotations

import logging

from .bus import PlaybackBus
from smartamp_audio import volume
from ..config import MusicBusConfig
from smartamp_audio.graph import Graph
from ..modules import ModuleRegistry


LOG = logging.getLogger(__name__)

class MusicBus(PlaybackBus):
    """The shared music path. Its bridge carries music gain and ducking;
    each input stream on it carries only its source's trim, which the
    mixer (sources.py) holds."""

    config: MusicBusConfig
    ducked: bool | None = None

    def __init__(
        self, config: MusicBusConfig, view: Graph, registry: ModuleRegistry
    ) -> None:
        super().__init__("music", config, "SmartAmp_Music_Audio", view, registry)

    def target_gain(self, music_volume: int, ducked: bool) -> int:
        """The bridge gain for the music level, dipped by the duck share."""
        if not ducked:
            return music_volume
        return volume.scale(music_volume, self.config.duck_volume_percent)

    def apply_ducking(self, music_volume: int, ducked: bool) -> None:
        if self.stream_index is None:
            return
        target = self.target_gain(music_volume, ducked)
        if self.ducked == ducked and self.gain_applied == target:
            return
        # A duck transition fades; the music level moving just snaps the gain,
        # tracking the detent that moved it.
        changed_duck = self.ducked != ducked
        fade_ms = self.config.fade_ms if changed_duck and self.ducked is not None else 0
        self._write_gain(target, fade_ms)
        self.ducked = ducked
        if changed_duck:
            LOG.info("%s music", "Ducked" if ducked else "Restored")

    def _forget_gain(self) -> None:
        super()._forget_gain()
        self.ducked = None
