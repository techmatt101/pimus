"""The source the assistant records: the device itself, or one channel of it."""

from __future__ import annotations

import logging
from typing import Any, Protocol

from ..graph import Graph, Node
from ..modules import ModuleRegistry


LOG = logging.getLogger(__name__)

# The mono source published for the voice assistant when a capture channel is
# selected. The name is what the assistant records and what the doctor script
# checks, so it stays as it is however the module around it is called.
SOURCE_NAME = "smartamp_voice_capture"

CAPTURE_ROLE = "_voice_capture"


class Capture(Protocol):
    """How the device's audio becomes the one source the assistant records."""

    def reconcile(self, device: Node | None) -> tuple[Node | None, dict[str, Any]]:
        """The source to make the default, and the status file's `voice_capture`."""
        ...


class DirectCapture:
    """A device whose capture is already what the assistant should hear."""

    def reconcile(self, device: Node | None) -> tuple[Node | None, dict[str, Any]]:
        return device, {"channel": None, "source": None}


class ChannelCapture:
    """One channel of a multi-output device, remapped to a mono source.

    A DSP array's USB capture channels are different outputs, not a stereo
    pair: on the XVF3800 channel 0 carries its Conference stream (post-processed
    for human listeners) and channel 1 its ASR stream (tuned for wake-word and
    speech recognition); on the ReSpeaker Lite channel 0 is the processed output
    and channel 1 a raw microphone. The assistant must hear exactly the chosen
    channel; recording the device in mono would instead downmix them.
    """

    def __init__(self, channel: int, view: Graph, registry: ModuleRegistry) -> None:
        self.channel = channel
        self._master_index: str | None = None
        self._graph = view
        self._modules = registry

    def reconcile(self, device: Node | None) -> tuple[Node | None, dict[str, Any]]:
        status: dict[str, Any] = {"channel": self.channel, "source": None}
        if device is None:
            self._release()
            return None, status
        master_channel = self._channel_label(device)
        if master_channel is None:
            self._release()
            return None, status
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
        return capture, status

    def _release(self) -> None:
        self._modules.unload(CAPTURE_ROLE)
        self._master_index = None

    def _channel_label(self, device: Node) -> str | None:
        labels = [
            label.strip()
            for label in str(device.get("channel_map", "")).split(",")
            if label.strip()
        ]
        if 0 <= self.channel < len(labels):
            return labels[self.channel]
        LOG.warning(
            "Voice capture channel %s is outside %s channel map %r; capture unavailable",
            self.channel,
            device.get("name"),
            device.get("channel_map"),
        )
        return None
