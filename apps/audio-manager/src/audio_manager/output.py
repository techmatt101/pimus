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


def hold_stray_streams(view: Graph, sink: Node | None, music_volume: int) -> None:
    """Hold anything that is not one of our bridges at the music level.

    With the sink pinned, a client that plays straight at the output would
    otherwise land at full amplifier level.
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
        if state is not None and state[0] == music_volume:
            continue
        pactl.set_sink_input_volume(int(stream["index"]), music_volume)
        LOG.info("Holding stray stream %s at the music level", stream.get("index"))
