"""What every tier shares: the unit's config, its levels before the run, and
the one socket connection whose leases the tiers hold.

The suite changes levels to measure them, so the levels it found are put back
however a tier ends, and it refuses to move anything while someone is
listening unless told to.
"""

from __future__ import annotations

import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, cast

from smartamp_audio import graph

from .audio import write_noise, write_tone
from .config import SILENT_CEILING_PERCENT, SelftestConfig
from .control import ControlClient, Event, section
from .report import Check, Outcome, Report
from .runtime import Runtime


# The music level the near-silent tiers measure at: with the ceiling parked
# at its floor, a -20 dBFS tone at this level leaves the amplifier some 80 dB
# down, and a level step from here is still far above the graph's floor.
QUIET_MUSIC_VOLUME = 30
QUIET_VOICE_VOLUME = 30
STIMULUS_SECONDS = 60.0
FADE_SETTLE_SECONDS = 0.7

BRIDGE_PREFIX = "SmartAmp."


@dataclass
class Options:
    silent: bool = False
    force: bool = False
    restart: bool = False
    only: set[str] = field(default_factory=lambda: set())
    skip: set[str] = field(default_factory=lambda: set())
    music_volume: int | None = None
    min_rise_db: float | None = None


@dataclass(frozen=True)
class Levels:
    music_volume: int
    music_muted: bool
    voice_volume: int | None
    output_volume: int | None
    trims: dict[str, int]
    enabled: dict[str, bool]

    @classmethod
    def of(cls, state: Event) -> Levels:
        sources = cast(dict[str, Any], state.get("sources") or {})
        return cls(
            music_volume=int(section(state, "music_bus", "volume") or 0),
            music_muted=bool(section(state, "music_bus", "muted")),
            voice_volume=_optional_int(section(state, "voice_bus", "volume")),
            output_volume=_optional_int(state.get("output_volume")),
            trims={
                name: int(cast(dict[str, Any], entry).get("trim", 100))
                for name, entry in sources.items()
            },
            enabled={
                name: bool(cast(dict[str, Any], entry)["enabled"])
                for name, entry in sources.items()
                if "enabled" in cast(dict[str, Any], entry)
            },
        )


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


class Session:
    def __init__(self, config: SelftestConfig, runtime: Runtime, report: Report,
                 options: Options) -> None:
        self.config = config
        self.runtime = runtime
        self.report = report
        self.options = options
        self.control = ControlClient(config.socket)
        self.levels: Levels | None = None
        self._workdir = Path(tempfile.mkdtemp(prefix="smartamp-selftest-"))
        self._tone: Path | None = None
        self._noise: Path | None = None

    # Results.

    def check(self, tier: str, name: str, ok: bool, detail: str = "",
              *, warn: bool = False) -> bool:
        outcome = Outcome.PASS if ok else (Outcome.WARN if warn else Outcome.FAIL)
        self.report.add(Check(tier, name, outcome, detail))
        return ok

    def skip(self, tier: str, name: str, detail: str) -> None:
        self.report.add(Check(tier, name, Outcome.SKIP, detail))

    def warn(self, tier: str, name: str, detail: str) -> None:
        self.report.add(Check(tier, name, Outcome.WARN, detail))

    # The connection and the levels it found.

    def open(self) -> None:
        self.control.connect()
        self.levels = Levels.of(self.control.state())

    def close(self) -> None:
        try:
            self.restore()
        finally:
            self.control.close()

    def restore(self) -> None:
        """Puts back every level found, each on its own, so one that fails
        cannot leave the rest at the test's values for the daemon to save."""
        levels = self.levels
        if levels is None:
            return
        failures: list[str] = []
        for what, action in self._restorations(levels):
            try:
                self._attempt(action)
            except Exception as error:  # noqa: BLE001 - restore the rest regardless
                failures.append(f"{what}: {type(error).__name__}: {error}")
        if failures:
            raise RuntimeError("; ".join(failures))

    def _restorations(self, levels: Levels) -> list[tuple[str, Callable[[], object]]]:
        control = self.control
        steps: list[tuple[str, Callable[[], object]]] = [
            ("duck", lambda: control.command("set-duck", active=False)),
            ("voice meter", lambda: control.command("set-voice-meter", active=False)),
            ("music level", lambda: control.command("set-music-volume", percent=levels.music_volume)),
            ("music mute", lambda: control.command("set-music-mute", muted=levels.music_muted)),
        ]
        voice_volume = levels.voice_volume
        if voice_volume is not None:
            steps.append(("voice level",
                          lambda: control.command("set-voice-volume", percent=voice_volume)))
        output_volume = levels.output_volume
        if output_volume is not None:
            steps.append(("output ceiling", lambda: self.set_ceiling(output_volume)))
        for name, trim in levels.trims.items():
            steps.append((f"{name} trim", lambda name=name, trim=trim: control.command(
                "set-source-trim", name=name, percent=trim)))
        for name, enabled in levels.enabled.items():
            steps.append((f"{name} switch", lambda name=name, enabled=enabled: control.command(
                "set-source-state", name=name, state="on" if enabled else "off")))
        return steps

    def _attempt(self, action: Callable[[], object]) -> None:
        """Runs one command, reconnecting once if the manager has gone away."""
        control = self.control
        try:
            if not control.connected:
                control.connect()
            action()
        except ConnectionError:
            control.close()
            control.connect()
            action()

    def set_ceiling(self, percent: int) -> None:
        """Moves the hardware ceiling, under the socket's floor too.

        The manager refuses a ceiling below its floor, but a unit may be
        configured under it, and the level found there must still be put
        back; root writes that one to the card directly, and the manager
        reads the card on its next pass.
        """
        ceiling = self.config.ceiling
        if ceiling is None:
            return
        if percent >= SILENT_CEILING_PERCENT:
            self.control.command("set-output-ceiling", percent=percent)
        elif not self.runtime.amixer_set_percent(ceiling.card, ceiling.control, percent):
            raise RuntimeError(f"amixer could not set {ceiling.control} to {percent}%")

    def quieten(self) -> None:
        """Parks the amplifier where a measurement is inaudible, never above
        the ceiling it was found at."""
        control = self.control
        if self.config.ceiling is not None:
            found = self.levels.output_volume if self.levels else None
            self.set_ceiling(SILENT_CEILING_PERCENT if found is None
                             else min(found, SILENT_CEILING_PERCENT))
        control.command("set-music-mute", muted=False)
        control.command("set-music-volume", percent=QUIET_MUSIC_VOLUME)
        if self.config.voice.enabled:
            control.command("set-voice-volume", percent=QUIET_VOICE_VOLUME)
        # The stimulus plays untagged, as the default source, whose trim
        # would otherwise be folded into every level it is measured at.
        for name in self.config.sources:
            control.command("set-source-trim", name=name, percent=100)
        time.sleep(FADE_SETTLE_SECONDS)

    def settle(self) -> None:
        time.sleep(FADE_SETTLE_SECONDS)

    # Whether the amp is in use.

    def client_streams(self, sink_name: str | None = None) -> list[graph.Node]:
        """Streams that are somebody's playback, not the daemons' own bridges."""
        sinks = {
            str(node.get("index")): str(node.get("name"))
            for node in self.runtime.pactl_list("sinks")
        }
        streams: list[graph.Node] = []
        for stream in self.runtime.pactl_list("sink-inputs"):
            if graph.media_name(stream).startswith(BRIDGE_PREFIX):
                continue
            if graph.properties_of(stream).get("application.name") == "smartamp-selftest":
                continue
            if sink_name is not None and sinks.get(str(stream.get("sink"))) != sink_name:
                continue
            streams.append(stream)
        return streams

    def playing(self) -> bool:
        """Whether a listener would hear a test. As the manager judges it, a
        stream of a source that is switched off is silence: the inputs app
        keeps its loopback on the bus, held at nothing, while it is off."""
        switched_off = self._switched_off_sources()
        return any(
            not stream.get("corked", False)
            and graph.properties_of(stream).get("smartamp.source") not in switched_off
            for stream in self.client_streams()
        )

    def _switched_off_sources(self) -> set[str]:
        if not self.control.connected:
            return set()
        sources = self.control.state().get("sources")
        if not isinstance(sources, dict):
            return set()
        return {
            str(name)
            for name, entry in cast(dict[str, Any], sources).items()
            if isinstance(entry, dict) and cast(dict[str, Any], entry).get("enabled") is False
        }

    def in_use(self, tier: str) -> bool:
        """Records a skip and answers True when a listener would notice a test."""
        if self.options.force or not self.playing():
            return False
        self.skip(tier, "amp in use", "something is playing; pass --force to test anyway")
        return True

    # The graph, as a check reads it.

    def output_sink(self) -> graph.Node | None:
        return graph.find_node(self.runtime.pactl_list("sinks"), self.config.output_match)

    def output_monitor(self) -> str | None:
        sink = self.output_sink()
        return graph.monitor_name(str(sink["name"])) if sink else None

    def bridge_present(self, role: str) -> bool:
        return any(
            graph.media_name(stream) == f"{BRIDGE_PREFIX}{role}"
            for stream in self.runtime.pactl_list("sink-inputs")
        )

    def bus_streams(self, sink_name: str) -> list[graph.Node]:
        return self.client_streams(sink_name)

    def source_streams(self, name: str) -> list[graph.Node]:
        return [
            stream
            for stream in self.bus_streams(self.config.music_sink)
            if graph.properties_of(stream).get("smartamp.source") == name
        ]

    def status(self) -> dict[str, Any] | None:
        return self.runtime.read_json(self.config.status)

    @staticmethod
    def status_sources(status: dict[str, Any]) -> list[str]:
        sources = status.get("sources")
        return [str(name) for name in cast(dict[str, Any], sources)] if isinstance(sources, dict) else []

    def inputs_status(self) -> dict[str, Any] | None:
        path = self.config.inputs_status
        return self.runtime.read_json(path) if path else None

    def wait_until(self, predicate: Callable[[], bool], timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            if predicate():
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.25)

    # Stimulus files, written once.

    def tone(self) -> Path:
        if self._tone is None:
            self._tone = write_tone(self._workdir / "tone.wav", STIMULUS_SECONDS)
            self._tone.chmod(0o644)
            self._workdir.chmod(0o755)
        return self._tone

    def noise(self, seconds: float, amplitude: float) -> Path:
        if self._noise is None:
            self._noise = write_noise(self._workdir / "noise.wav", seconds, amplitude=amplitude)
            self._noise.chmod(0o644)
            self._workdir.chmod(0o755)
        return self._noise
