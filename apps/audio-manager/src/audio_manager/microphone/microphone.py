"""One microphone: its device, its capture, and its echo reference, as a unit."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import capture as capture_module
from .capture import Capture, ChannelCapture, DirectCapture
from .device import find_device
from .echo_reference import EchoReference, NoEchoReference, PlaybackEchoReference
from ..config import MicrophoneConfig
from smartamp_audio.graph import Graph, Node
from ..modules import ModuleRegistry


@dataclass(frozen=True)
class MicrophoneStatus:
    """What one pass found, in the shape the status file publishes it."""

    # The capture device, as `voice_input`.
    device: str | None
    # The source the assistant should record from, to be made the default.
    source: Node | None
    # The status file's `voice_capture` and `aec_reference` sections.
    capture: dict[str, Any]
    echo_reference: dict[str, Any]


class Microphone:
    def __init__(
        self, match: str, capture: Capture, echo_reference: EchoReference, view: Graph
    ) -> None:
        self.match = match
        self.capture = capture
        self.echo_reference = echo_reference
        self._graph = view

    def reconcile(self, output: Node | None, *, awake: bool = True) -> MicrophoneStatus:
        """Keep the assistant's source published and the reference flowing.

        The capture path is kept whether or not the graph is awake, because
        the wake word must keep hearing through an idle teardown; only the
        reference is released with the other bridges.
        """
        device = find_device(
            self._graph, self.match, excluding=capture_module.SOURCE_NAME
        )
        source, capture_status = self.capture.reconcile(device)
        reference_status = self.echo_reference.reconcile(output, wanted=awake)
        return MicrophoneStatus(
            device=device.get("name") if device else None,
            source=source,
            capture=capture_status,
            echo_reference=reference_status,
        )


def build(config: MicrophoneConfig, view: Graph, registry: ModuleRegistry) -> Microphone:
    """The microphone the configuration describes, assembled from its parts."""
    capture: Capture = (
        DirectCapture()
        if config.capture_channel is None
        else ChannelCapture(config.capture_channel, view, registry)
    )
    echo_reference: EchoReference = (
        PlaybackEchoReference(config.echo_reference, view, registry)
        if config.echo_reference.enabled
        else NoEchoReference()
    )
    return Microphone(config.match, capture, echo_reference, view)
