"""Publishing one capture channel of the voice device as a mono source."""

from __future__ import annotations

import logging
from typing import Any

from .graph import Graph, Node
from .modules import ModuleRegistry


LOG = logging.getLogger(__name__)

# The mono source published for the voice assistant when a capture channel is
# selected; see VoiceCapture for why the device is not used directly.
SOURCE_NAME = "smartamp_voice_capture"

CAPTURE_ROLE = "_voice_capture"


class VoiceCapture:
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
        self._graph = view
        self._modules = registry

    def reconcile(self, device: Node | None) -> tuple[Node | None, dict[str, Any]]:
        """Returns the source the assistant should record from, and its status."""
        status: dict[str, Any] = {"channel": self.channel, "source": None}
        if self.channel is None or device is None:
            self._modules.unload(CAPTURE_ROLE)
            return device, status
        master_channel = self._channel_label(device)
        if master_channel is None:
            self._modules.unload(CAPTURE_ROLE)
            return device, status
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
