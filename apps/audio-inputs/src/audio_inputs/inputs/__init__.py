"""One `Input` class per kind of device, chosen by the config's `kind`.

    input        the base: the device found by match, the loopback run for it
    capture      an analogue capture node, bridged whenever the graph is awake
    usb_gadget   the UAC2 gadget, bridged only while the computer streams, with
                 its host mixer kept agreed with the music bus's volume
    gadget       the gadget card's controls, and whether a host is there
    usb_volume   the two-way agreement between that mixer and the bus register

Adding a kind is a class here and a row in KINDS; the source it plays as is a
name in the audio manager's config, which is where its trim and toggle live.
"""

from __future__ import annotations

from smartamp_audio.graph import Graph
from ..config import InputConfig
from .capture import CaptureInput
from .input import Input
from .usb_gadget import UsbGadgetInput


KINDS: dict[str, type[Input]] = {
    "capture": CaptureInput,
    "usb_gadget": UsbGadgetInput,
}


def create(name: str, config: InputConfig, view: Graph) -> Input:
    kind = KINDS.get(config.kind)
    if kind is None:
        raise ValueError(f"input {name!r} has unknown kind {config.kind!r}")
    return kind(name, config, view)
