"""The voice assistant's bus, so speech has a level independent of the music."""

from __future__ import annotations

from smartamp_audio import volume
from .bus import PlaybackBus
from .voice_meter import VoiceLevelMeter
from ..config import VoiceBusConfig
from ..fades import Fades
from smartamp_audio.graph import Graph, Node
from ..modules import ModuleRegistry


class VoiceBus(PlaybackBus):
    """TTS, timers, and announcements would otherwise play straight to the
    default sink, which is also where music plays; a bus of their own is what
    lets a voice level be held independently. Its monitor carries the speech
    and nothing else, which is what the meter listens to. The level is the
    bus's own, requested here and applied as its bridge gain."""

    config: VoiceBusConfig

    def __init__(
        self,
        config: VoiceBusConfig,
        view: Graph,
        registry: ModuleRegistry,
        meter: VoiceLevelMeter,
        fades: Fades,
        volume: int,
    ) -> None:
        super().__init__("voice", config, "SmartAmp_Voice_Audio", view, registry, fades)
        self.meter = meter
        self.volume = volume

    def set_volume(self, percent: float) -> None:
        self.volume = volume.clamp(percent)
        self.apply_level()

    def apply_level(self) -> None:
        self.apply_gain(self.volume)

    def reconcile(self, output: Node | None, *, bridged: bool = True) -> Node | None:
        sink = super().reconcile(output, bridged=bridged)
        self.meter.set_source(self.monitor_name if self.available else None)
        return sink
