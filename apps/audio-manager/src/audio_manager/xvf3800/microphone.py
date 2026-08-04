"""Publishing one capture channel of the voice device as a mono source."""

from __future__ import annotations

import logging
from typing import Any

from ..system import pactl
from ..graph import Graph, Node
from ..modules import ModuleRegistry


LOG = logging.getLogger(__name__)


def activate_capture_card(view: Graph, pattern: str) -> None:
    # A card re-enumerating after a USB power cycle can be probed before the
    # XVF3800's capture side is ready, leaving WirePlumber restored onto a
    # profile - sometimes an entire profile list - with no input; the voice
    # source then never appears and the assistant cannot start. Switch to the
    # best profile that actually offers a source, preferring one that keeps a
    # sink so the AEC reference endpoint survives, and let the resulting graph
    # event schedule the reconcile that finds the node.
    card = view.find_card(pattern)
    if card is None:
        return
    profiles = card.get("profiles") or {}
    active = profiles.get(str(card.get("active_profile", "")))
    if isinstance(active, dict) and int(active.get("sources", 0) or 0) > 0:
        return
    candidates = [
        (name, profile)
        for name, profile in profiles.items()
        if isinstance(profile, dict) and int(profile.get("sources", 0) or 0) > 0
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

# The mono source published for the voice assistant when a capture channel is
# selected; see Microphone for why the device is not used directly. The name is
# what the assistant records and what the doctor script checks, so it stays as
# it is however the module around it is called.
SOURCE_NAME = "smartamp_voice_capture"

CAPTURE_ROLE = "_voice_capture"


class Microphone:
    """The XVF3800's ASR channel, remapped to mono for the voice assistant.

    The device's two USB capture channels are different DSP outputs, not a
    stereo pair: channel 0 carries its Conference stream (post-processed for
    human listeners) and channel 1 its ASR stream (tuned for wake-word and
    speech recognition). The voice assistant must hear exactly the ASR channel;
    recording the device in mono would instead downmix the two.
    """

    def __init__(
        self, channel: int | None, view: Graph, registry: ModuleRegistry
    ) -> None:
        self.channel = channel
        self._master_index: str | None = None
        self._graph = view
        self._modules = registry

    def reconcile(self, device: Node | None) -> tuple[Node | None, dict[str, Any]]:
        """Returns the source the assistant should record from, and its status."""
        status: dict[str, Any] = {"channel": self.channel, "source": None}
        if self.channel is None or device is None:
            self._modules.unload(CAPTURE_ROLE)
            self._master_index = None
            return device, status
        master_channel = self._channel_label(device)
        if master_channel is None:
            self._modules.unload(CAPTURE_ROLE)
            self._master_index = None
            return device, status
        # A remap module can outlive its master: after a USB power cycle the
        # device node is recreated under the same name, and the surviving
        # module keeps publishing silence from the node that no longer exists.
        # A new master identity means the remap must be rebuilt against it.
        master_index = str(device.get("index")) if device.get("index") is not None else None
        if master_index is not None and self._master_index not in (None, master_index):
            self._modules.unload(CAPTURE_ROLE)
            LOG.info("Voice capture master was recreated; rebuilding the remap")
        self._master_index = master_index
        created = self._modules.ensure_remap_source(
            CAPTURE_ROLE,
            SOURCE_NAME,
            device["name"],
            master_channel,
            "SmartAmp_Voice_Capture",
        )
        if created:
            LOG.info(
                "Publishing %s channel %s as the voice capture source",
                device["name"],
                self.channel,
            )
        capture = self._graph.source_named(SOURCE_NAME)
        status["source"] = capture.get("name") if capture else None
        return capture or device, status

    def _channel_label(self, device: Node) -> str | None:
        labels = [
            label.strip()
            for label in str(device.get("channel_map", "")).split(",")
            if label.strip()
        ]
        if self.channel is not None and self.channel < len(labels):
            return labels[self.channel]
        LOG.warning(
            "Voice capture channel %s is outside %s channel map %r; capturing unmapped",
            self.channel,
            device.get("name"),
            device.get("channel_map"),
        )
        return None
