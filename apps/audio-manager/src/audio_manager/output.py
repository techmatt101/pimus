"""The output sink policy: pinned at full scale, with nothing playing above it.

The sink is not the volume control any more — music and voice each carry their
own bridge gain — so it stays pinned at full scale (WirePlumber restores
whatever it last had) and the HiFiBerry hardware ceiling is the only cap above
the bus gains.
"""

from __future__ import annotations

import logging

from . import graph, pactl
from .graph import Graph, Node
from .modules import STREAM_PREFIX


LOG = logging.getLogger(__name__)


def pin_volume(sink: Node | None) -> None:
    if sink is None:
        return
    state = graph.volume_state(sink)
    if state is None or state[0] == 100:
        return
    pactl.set_sink_volume(sink["name"], 100)
    LOG.info("Pinned the output sink to 100%%")


def mute_state(sink: Node | None) -> bool | None:
    """Whether the output sink is muted, or None when it reports no volume.

    Mute is the one part of output loudness that does not live on a bus gain:
    silencing the sink silences music and voice together, which is what the
    controller's mute key means. Reading it here is what lets the controller
    show a mute made by any other client without polling for it.
    """
    if sink is None:
        return None
    state = graph.volume_state(sink)
    return None if state is None else state[1]


def set_mute(sink: Node | None, muted: bool) -> None:
    if sink is None:
        raise RuntimeError("no output sink to mute")
    pactl.set_sink_mute(sink["name"], muted)
    LOG.info("Output sink %s", "muted" if muted else "unmuted")


def hold_client_streams(view: Graph, sink: Node | None, level: int) -> None:
    """Hold every stream on the sink that is not one of our bridges at a level.

    On the pinned output sink this stops a client that plays straight at the
    output landing at full amplifier level; on the background bus it holds the
    Sendspin player's stream at its configured trim.
    """
    if sink is None or sink.get("index") is None:
        return
    for stream in view.sink_inputs:
        if str(stream.get("sink")) != str(sink.get("index")):
            continue
        media = str((stream.get("properties") or {}).get("media.name", ""))
        if media.startswith(STREAM_PREFIX):
            continue
        state = graph.volume_state(stream)
        if state is not None and state[0] == level:
            continue
        pactl.set_sink_input_volume(int(stream["index"]), level)
        LOG.info("Holding client stream %s at %s%%", stream.get("index"), level)
