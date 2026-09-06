"""Finding the capture device, and repairing its card when it comes back wrong."""

from __future__ import annotations

import logging

from smartamp_audio import pactl
from smartamp_audio.graph import Graph, Node, profiles_of


LOG = logging.getLogger(__name__)


def find_device(view: Graph, pattern: str, *, excluding: str) -> Node | None:
    """The capture node the match names, or None once its card is repaired.

    A published remap source names its master device in its own properties,
    so it would match the pattern itself; it is excluded or it becomes its own
    master on the next reconcile.
    """
    device = view.find_source(pattern, excluding=excluding)
    if device is None:
        repair_capture_profile(view, pattern)
    return device


def repair_capture_profile(view: Graph, pattern: str) -> None:
    # A card re-enumerating after a USB power cycle can be probed before its
    # capture side is ready, leaving WirePlumber restored onto a profile -
    # sometimes an entire profile list - with no input; the voice source then
    # never appears and the assistant cannot start. Switch to the best profile
    # that actually offers a source, preferring one that keeps a sink so an
    # echo reference endpoint survives, and let the resulting graph event
    # schedule the reconcile that finds the node.
    card = view.find_card(pattern)
    if card is None:
        return
    profiles = profiles_of(card)
    active = profiles.get(str(card.get("active_profile", "")))
    if active is not None and int(active.get("sources", 0) or 0) > 0:
        return
    candidates = [
        (name, profile)
        for name, profile in profiles.items()
        if int(profile.get("sources", 0) or 0) > 0
    ]
    if not candidates:
        return
    name, _ = max(
        candidates,
        key=lambda item: (
            int(item[1].get("sinks", 0) or 0) > 0,
            int(item[1].get("priority", 0) or 0),
        ),
    )
    pactl.set_card_profile(str(card["name"]), name)
    view.invalidate()
    LOG.info(
        "Activated %s profile on card %s for voice capture", name, card.get("name")
    )
