"""The music level and its mute: one number every music path plays at."""

from __future__ import annotations

from smartamp_audio import volume
from smartamp_audio.graph import Graph, Node
from .music_volume import MusicVolumeSync


class MusicLevel:
    """The requested music level, and the mute that stands in for it.

    The level is not a bus gain of its own: the music bridge carries it dipped
    by the duck share, and every client playing straight at the output is held
    at it too. Its public face is the music bus sink's volume, kept agreed
    through the register so a player can move the room and be told when the
    dial moved it instead.
    """

    def __init__(self, volume: int, muted: bool) -> None:
        self.volume = volume
        self.muted = muted
        self._register = MusicVolumeSync()

    @property
    def level(self) -> int:
        """The gain every music path plays at: the level, or silence.

        The mute is this one substitution. The buses and the mixer never learn
        of it, the voice bus keeps its own level, and the level itself is
        untouched so an unmute lands exactly where the dial was.
        """
        return 0 if self.muted else self.volume

    def set_volume(self, percent: float) -> None:
        self.volume = volume.clamp(percent)
        # Seed the public register from this explicit command.
        self._register.forget()

    def set_muted(self, muted: bool) -> None:
        self.muted = muted
        self._register.forget()

    def sync_register(self, sink: Node | None, view: Graph) -> None:
        """Agree the level with the bus sink's own volume, whichever side moved."""
        self.volume, self.muted = self._register.sync(
            sink, (self.volume, self.muted), view
        )
