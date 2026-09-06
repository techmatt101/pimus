"""Synchronise the USB host mixer with the music bus's public volume register.

The bus sink's volume is the music level's public face, which Sendspin and any
other player read and write; the computer's slider is made one more of them.
"""
from __future__ import annotations

from smartamp_audio import graph, pactl, volume
from smartamp_audio.graph import Graph, Node
from . import gadget

VolumeState = tuple[int, bool]


class UsbVolumeSync:
    def __init__(self) -> None:
        self._agreed: tuple[VolumeState, VolumeState] | None = None
        self._identity: tuple[object, ...] | None = None
        self._pending: VolumeState | None = None

    def forget(self) -> None:
        self._agreed = None
        self._identity = None
        self._pending = None

    def sync(self, sink: Node | None, view: Graph) -> None:
        if sink is None or not gadget.card_present():
            self.forget()
            return
        identity = (sink["name"], sink.get("index"))
        if identity != self._identity:
            self.forget()
            self._identity = identity
        bus = graph.volume_state(sink)
        host = gadget.read_mixer()
        if bus is None or host is None:
            return
        if self._pending is not None:
            self._write_bus(sink, view)
        elif self._agreed is None or bus != self._agreed[1]:
            # Attachment/recreation seeds the host from the room. A changed bus
            # also wins simultaneous changes, so explicit dial/Sendspin commands
            # cannot be pulled back by a stale host mixer reading.
            gadget.write_mixer(*bus)
            written = gadget.read_mixer() or bus
            self._agreed = (written if gadget.volumes_match(written, bus) else bus, bus)
        elif not gadget.volumes_match(host, self._agreed[0]):
            self._pending = (volume.clamp(host[0]), host[1])
            self._write_bus(sink, view)

    def _write_bus(self, sink: Node, view: Graph) -> None:
        assert self._pending is not None
        desired = self._pending
        pactl.set_sink_volume(str(sink["name"]), desired[0])
        pactl.set_sink_mute(str(sink["name"]), desired[1])
        view.invalidate()
        written = view.sink_named(str(sink["name"]))
        actual = (graph.volume_state(written) if written is not None else None) or desired
        # Remember the request we applied. A newer host change during a retry,
        # or a competing bus command during read-back, must remain detectable.
        self._agreed = (
            desired, actual if gadget.volumes_match(actual, desired) else desired
        )
        self._pending = None
