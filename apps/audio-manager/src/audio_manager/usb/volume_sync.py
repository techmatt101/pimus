"""Keeping the USB host's volume slider and the amp's music level converged."""

from __future__ import annotations

import logging

from .. import volume
from ..system import pactl, usb_gadget
from ..graph import Node


LOG = logging.getLogger(__name__)

VolumeState = tuple[int, bool]


class UsbVolumeSync:
    """Whichever side moved since the last agreement wins, the host on a tie.

    The host writes volume and mute to the gadget card's mixer; the amp's side
    is the music level (the sink itself stays pinned) plus the sink mute. At
    first sight the amp seeds the gadget so a computer plugging in reads the
    real level.
    """

    def __init__(self) -> None:
        # The last (gadget, amp) volume states the two sides agreed on, each
        # remembered as read from its own side so quantisation differences
        # between them cannot register as a fresh change.
        self._agreed: tuple[VolumeState, VolumeState] | None = None

    def forget(self) -> None:
        """Drop the agreement so the amp's level seeds the gadget again."""
        self._agreed = None

    def sync(self, sink: Node | None, music_volume: int) -> int:
        """Returns the music level after whichever side moved has won."""
        if sink is None or not usb_gadget.card_present():
            return music_volume
        gadget = usb_gadget.read_mixer()
        if gadget is None:
            return music_volume
        amp: VolumeState = (music_volume, bool(sink.get("mute", False)))
        if self._agreed is not None and not usb_gadget.volumes_match(
            gadget, self._agreed[0]
        ):
            return self._follow_host(sink, gadget)
        if self._agreed is None or not usb_gadget.volumes_match(amp, self._agreed[1]):
            self._seed_host(amp)
        return music_volume

    def _follow_host(self, sink: Node, gadget: VolumeState) -> int:
        music_volume = volume.clamp(gadget[0])
        pactl.set_sink_mute(sink["name"], gadget[1])
        self._agreed = (gadget, (music_volume, gadget[1]))
        LOG.info("USB host set volume %d%%%s", gadget[0], " muted" if gadget[1] else "")
        return music_volume

    def _seed_host(self, amp: VolumeState) -> None:
        usb_gadget.write_mixer(*amp)
        self._agreed = (usb_gadget.read_mixer() or amp, amp)
