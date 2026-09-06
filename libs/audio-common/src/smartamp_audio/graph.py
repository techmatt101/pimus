"""Reading the PipeWire graph: node matching and one cached view per pass."""

from __future__ import annotations

import re
from typing import Any, cast

from smartamp_audio import pactl


Node = dict[str, Any]
Properties = dict[str, Any]

# pactl reports "no monitor" as an unsigned -1.
NOT_A_MONITOR = (None, 4294967295, "4294967295")


def properties_of(node: Node) -> Properties:
    properties = node.get("properties")
    return cast(Properties, properties) if isinstance(properties, dict) else {}


def media_name(stream: Node) -> str:
    return str(properties_of(stream).get("media.name", ""))


def profiles_of(card: Node) -> dict[str, Properties]:
    profiles = card.get("profiles")
    if not isinstance(profiles, dict):
        return {}
    return {
        str(name): profile
        for name, profile in cast(dict[object, object], profiles).items()
        if isinstance(profile, dict)
    }


def searchable(node: Node) -> str:
    return " ".join(
        str(value)
        for value in (
            node.get("name", ""),
            node.get("description", ""),
            *properties_of(node).values(),
        )
    )


def is_monitor(node: Node) -> bool:
    return node.get("monitor_of_sink") not in NOT_A_MONITOR or str(
        node.get("name", "")
    ).endswith(".monitor")


def monitor_name(sink_name: str) -> str:
    return f"{sink_name}.monitor"


def find_node(
    nodes: list[Node], pattern: str, *, allow_monitor: bool = False
) -> Node | None:
    matcher = re.compile(pattern, re.IGNORECASE)
    return next(
        (
            node
            for node in nodes
            if (allow_monitor or not is_monitor(node))
            and matcher.search(searchable(node))
        ),
        None,
    )


def node_named(nodes: list[Node], name: str) -> Node | None:
    return next((node for node in nodes if node.get("name") == name), None)


def find_owned_stream(
    streams: list[Node], module_id: int | None, media_name: str = ""
) -> Node | None:
    if module_id is None and not media_name:
        return None
    return next(
        (
            stream
            for stream in streams
            if (
                module_id is not None
                and str(stream.get("owner_module")) == str(module_id)
            )
            or (media_name and properties_of(stream).get("media.name") == media_name)
        ),
        None,
    )


def find_loaded_module(
    modules: list[Node], module_name: str, required_arguments: tuple[str, ...]
) -> Node | None:
    return next(
        (
            module
            for module in modules
            if module.get("name") == module_name
            and all(
                argument in str(module.get("argument", "")).split()
                for argument in required_arguments
            )
        ),
        None,
    )


def channel_volumes(node: Node) -> list[int]:
    channels = node.get("volume")
    if not isinstance(channels, dict):
        return []
    return [
        int(match.group(1))
        for channel in cast(dict[object, object], channels).values()
        if isinstance(channel, dict)
        and (
            match := re.match(
                r"(\d+)%", str(cast(Properties, channel).get("value_percent", ""))
            )
        )
    ]


def volume_is(node: Node, percent: int) -> bool:
    levels = channel_volumes(node)
    return bool(levels) and all(level == percent for level in levels)


def volume_state(node: Node) -> tuple[int, bool] | None:
    """A sink's or stream's (loudest channel percent, muted), if it reports one."""
    percents = channel_volumes(node)
    if not percents:
        return None
    return max(percents), bool(node.get("mute", False))


class Graph:
    """The PipeWire listings, fetched on demand and dropped when they change.

    Every reconcile reads the same graph several times; caching turns that into
    one `pactl list` per kind. Anything that mutates the graph must invalidate,
    which ModuleRegistry does whenever it loads or unloads a module.
    """

    def __init__(self) -> None:
        self._listings: dict[str, list[Node]] = {}
        self._modules: list[Node] | None = None

    def invalidate(self) -> None:
        self._listings.clear()
        self._modules = None

    @property
    def sinks(self) -> list[Node]:
        return self._listing("sinks")

    @property
    def sources(self) -> list[Node]:
        return self._listing("sources")

    @property
    def sink_inputs(self) -> list[Node]:
        return self._listing("sink-inputs")

    @property
    def cards(self) -> list[Node]:
        return self._listing("cards")

    @property
    def modules(self) -> list[Node]:
        if self._modules is None:
            self._modules = pactl.list_modules()
        return self._modules

    def find_sink(self, pattern: str) -> Node | None:
        return find_node(self.sinks, pattern)

    def find_source(self, pattern: str, *, excluding: str = "") -> Node | None:
        candidates = [node for node in self.sources if node.get("name") != excluding]
        return find_node(candidates, pattern)

    def find_card(self, pattern: str) -> Node | None:
        return find_node(self.cards, pattern)

    def sink_named(self, name: str) -> Node | None:
        return node_named(self.sinks, name)

    def source_named(self, name: str) -> Node | None:
        return node_named(self.sources, name)

    def _listing(self, kind: str) -> list[Node]:
        listing = self._listings.get(kind)
        if listing is None:
            listing = pactl.list_json(kind)
            self._listings[kind] = listing
        return listing
