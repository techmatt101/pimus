"""The music bus sink's own volume and mute, as the music level's public face.

The level itself is a gain on the bus's bridge, exactly as every other level
here is. This is a control surface beside it: an ordinary PipeWire sink volume
that anything able to drive one can read, write, and subscribe to. A player
that watches its own output device therefore moves the music level by moving
it, and is told by the same event when the dial or a USB host moved it instead
— which is what keeps one room at one loudness without this daemon knowing
which players exist.

It is deliberately not the gain. The bus is created with
`monitor.channel-volumes` off, so the sink's volume never reaches the monitor
the bridge carries; if that ever stopped holding, the result would be a room
that plays quieter than asked for, never louder. The voice bus is a sink of its
own and is not mirrored here, so the assistant keeps its level whatever a music
player does with this one.
"""

from __future__ import annotations

import logging

from .. import graph, volume
from ..graph import Graph, Node
from ..system import pactl


LOG = logging.getLogger(__name__)

VolumeState = tuple[int, bool]


class MusicVolumeSync:
    """Whichever side moved since the last agreement wins, the register on a tie.

    The same shape as the USB host's agreement, for the same reason: two sides
    hold the one level, and only a remembered agreement can say which of them
    moved. The amp seeds the register at first sight, so a player reading it
    before anyone has touched it sees the real level.
    """

    def __init__(self) -> None:
        # The last (register, amp) states the two sides agreed on, each as read
        # from its own side.
        self._agreed: tuple[VolumeState, VolumeState] | None = None

    def forget(self) -> None:
        """Drop the agreement so the amp's level seeds the register again."""
        self._agreed = None

    def sync(self, sink: Node | None, amp: VolumeState, view: Graph) -> VolumeState:
        if sink is None:
            self.forget()
            return amp
        register = graph.volume_state(sink)
        if register is None:
            return amp
        if self._agreed is not None and register != self._agreed[0]:
            return self._follow_register(register)
        if self._agreed is None or amp != self._agreed[1]:
            self._write(sink, amp, view)
        return amp

    def _follow_register(self, register: VolumeState) -> VolumeState:
        amp = (volume.clamp(register[0]), register[1])
        self._agreed = (register, amp)
        LOG.info(
            "Music volume set to %d%%%s on the bus",
            amp[0],
            " muted" if amp[1] else "",
        )
        return amp

    def _write(self, sink: Node | None, amp: VolumeState, view: Graph) -> None:
        if sink is None:
            return
        name = str(sink["name"])
        pactl.set_sink_volume(name, amp[0])
        pactl.set_sink_mute(name, amp[1])
        # Read the register back rather than assuming the write landed exactly:
        # a sink can quantise, and an agreement remembered as what was asked for
        # would then read as a fresh change on the very next pass.
        view.invalidate()
        written = view.sink_named(name)
        self._agreed = (
            (graph.volume_state(written) if written is not None else None) or amp,
            amp,
        )
