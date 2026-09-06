from __future__ import annotations
# pyright: reportPrivateUsage=false

import json
from contextlib import ExitStack
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).parents[3] / "libs/audio-common/src"))

from smartamp_audio import graph, pactl
from audio_inputs.config import InputConfig, InputsConfig
from audio_inputs.daemon import AudioInputs
from audio_inputs.inputs import gadget
from audio_inputs.inputs.capture import CaptureInput
from audio_inputs.inputs.usb_gadget import UsbGadgetInput
from audio_inputs.inputs.usb_volume import UsbVolumeSync
from audio_inputs.loopback import Loopback


def node(name: str, index: int, percent: int = 40, muted: bool = False) -> graph.Node:
    return {"name": name, "index": index, "mute": muted,
            "volume": {channel: {"value_percent": f"{percent}%"} for channel in ("left", "right")}}


class VolumeAgreementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.bus = node("music", 2)
        self.host = (80, False)
        self.view = graph.Graph()
        self.sync = UsbVolumeSync()
        self.present = self.contexts.enter_context(mock.patch.object(gadget, "card_present", return_value=True))
        self.contexts.enter_context(mock.patch.object(gadget, "read_mixer", side_effect=lambda: self.host))
        self.write_host = self.contexts.enter_context(mock.patch.object(gadget, "write_mixer", side_effect=self.seed))
        read_sink: Callable[[str], graph.Node] = lambda _: self.bus
        self.contexts.enter_context(mock.patch.object(self.view, "sink_named", side_effect=read_sink))
        self.write_bus = self.contexts.enter_context(mock.patch.object(pactl, "set_sink_volume", side_effect=self.level))
        self.mute_bus = self.contexts.enter_context(mock.patch.object(pactl, "set_sink_mute", side_effect=self.mute))

    def seed(self, percent: int, muted: bool) -> None:
        self.host = percent, muted

    def level(self, name: str, percent: int) -> None:
        self.assertEqual(name, "music")
        self.bus.update(node(name, int(self.bus["index"]), percent, bool(self.bus["mute"])))

    def mute(self, name: str, muted: bool) -> None:
        self.assertEqual(name, "music")
        self.bus["mute"] = muted

    def test_host_bus_and_mute_follow_both_directions_without_repeated_writes(self) -> None:
        self.sync.sync(self.bus, self.view)
        self.assertEqual(self.host, (40, False))
        self.host = (55, True)
        self.sync.sync(self.bus, self.view)
        self.assertEqual(graph.volume_state(self.bus), (55, True))
        self.host = (55, False)
        self.sync.sync(self.bus, self.view)
        self.assertEqual(graph.volume_state(self.bus), (55, False))
        self.bus.update(node("music", 2, 70, True))
        self.sync.sync(self.bus, self.view)
        self.assertEqual(self.host, (70, True))
        for write in (self.write_host, self.write_bus, self.mute_bus):
            write.reset_mock()
        self.sync.sync(self.bus, self.view)
        for write in (self.write_host, self.write_bus, self.mute_bus):
            write.assert_not_called()

    def test_bus_command_wins_a_simultaneous_stale_host_change(self) -> None:
        self.sync.sync(self.bus, self.view)
        self.host = (30, True)
        self.bus.update(node("music", 2, 60))
        self.sync.sync(self.bus, self.view)
        self.assertEqual(self.host, (60, False))
        self.write_bus.assert_not_called()

    def test_gadget_reappearance_and_bus_recreation_seed_from_the_room(self) -> None:
        self.sync.sync(self.bus, self.view)
        self.present.return_value = False
        self.sync.sync(self.bus, self.view)
        self.present.return_value = True
        self.host = (100, False)
        self.sync.sync(self.bus, self.view)
        self.assertEqual(self.host, (40, False))
        self.host = (90, True)
        self.bus.update(node("music", 3, 25))
        self.sync.sync(self.bus, self.view)
        self.assertEqual(self.host, (25, False))
        self.sync.sync(None, self.view)
        self.host = (100, False)
        self.sync.sync(self.bus, self.view)
        self.assertEqual(self.host, (25, False))

    def test_quantisation_is_not_a_new_host_command(self) -> None:
        self.sync.sync(self.bus, self.view)
        self.host = (41, False)
        self.sync.sync(self.bus, self.view)
        self.write_bus.assert_not_called()

    def test_partial_bus_write_retries_volume_and_mute(self) -> None:
        self.sync.sync(self.bus, self.view)
        self.host = (30, True)
        self.mute_bus.side_effect = OSError("mixer unavailable")
        with self.assertRaises(OSError):
            self.sync.sync(self.bus, self.view)
        self.assertEqual(graph.volume_state(self.bus), (30, False))
        self.mute_bus.side_effect = self.mute
        self.sync.sync(self.bus, self.view)
        self.assertEqual(graph.volume_state(self.bus), (30, True))
        self.assertEqual(self.host, (30, True))

    def test_newer_host_change_during_a_failed_write_is_not_lost(self) -> None:
        self.sync.sync(self.bus, self.view)
        self.host = (30, True)
        self.mute_bus.side_effect = OSError("unavailable")
        with self.assertRaises(OSError):
            self.sync.sync(self.bus, self.view)
        self.host = (65, False)
        self.mute_bus.side_effect = self.mute
        self.sync.sync(self.bus, self.view)
        self.sync.sync(self.bus, self.view)
        self.assertEqual(graph.volume_state(self.bus), (65, False))

    def test_competing_bus_command_during_readback_is_reported_to_host(self) -> None:
        self.sync.sync(self.bus, self.view)
        self.host = (30, True)

        def competing_command(_: str, __: bool) -> None:
            self.bus.update(node("music", 2, 60, False))

        self.mute_bus.side_effect = competing_command
        self.sync.sync(self.bus, self.view)
        self.sync.sync(self.bus, self.view)
        self.assertEqual(self.host, (60, False))


class LoopbackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.view = graph.Graph()
        self.loopback = Loopback("usb", self.view, 40)
        self.child = mock.Mock()
        self.child.poll.return_value = None
        self.spawn = self.contexts.enter_context(mock.patch("audio_inputs.loopback.subprocess.Popen", return_value=self.child))
        self.streams: list[graph.Node] = []
        listing: Callable[[str], list[graph.Node]] = lambda _: self.streams
        self.contexts.enter_context(mock.patch.object(pactl, "list_json", side_effect=listing))
        self.source = node("gadget", 1)
        self.sink = node("music", 2)

    def publish(self) -> None:
        self.streams[:] = [{**node("stream", 20, 0), "properties": {
            "node.name": self.loopback._node_name,
        }}]
        self.view.invalidate()

    def test_stream_is_born_silent_unmuted_and_tagged_with_its_source(self) -> None:
        self.loopback.reconcile(self.source, self.sink)
        args = self.spawn.call_args.args[0]
        self.assertEqual(args[:5], ["pw-loopback", "--capture", "gadget", "--playback", "music"])
        props = json.loads(args[args.index("--playback-props") + 1])
        # Silent by volume, never by mute: the manager holds the volume at
        # the source's trim and has no reason to touch the mute.
        self.assertEqual(props["node.param.Props"], {"mute": False, "channelVolumes": [0.0, 0.0]})
        self.assertEqual(props["smartamp.source"], "usb")
        self.assertFalse(props["media.name"].startswith("SmartAmp."))
        for option in ("--capture-props", "--playback-props"):
            properties = json.loads(args[args.index(option) + 1])
            self.assertTrue(properties["node.dont-fallback"])
            self.assertTrue(properties["node.dont-reconnect"])
            self.assertFalse(properties["state.restore-props"])
        self.assertFalse(self.loopback.ready)
        self.publish()
        self.loopback.reconcile(self.source, self.sink)
        self.assertTrue(self.loopback.ready)
        self.spawn.assert_called_once()

    def test_recreated_target_reaps_old_client_and_ignores_its_stream(self) -> None:
        self.loopback.reconcile(self.source, self.sink)
        self.publish()
        self.loopback.reconcile(self.source, node("music", 3))
        self.child.terminate.assert_called_once()
        self.child.wait.assert_called_once()
        self.assertEqual(self.spawn.call_count, 2)
        self.assertFalse(self.loopback.ready)

    def test_exited_client_is_restarted_and_stop_releases_it(self) -> None:
        self.loopback.reconcile(self.source, self.sink)
        self.child.poll.return_value = 1
        self.loopback.reconcile(self.source, self.sink)
        self.assertEqual(self.spawn.call_count, 2)
        self.child.poll.return_value = None
        self.loopback.stop()
        self.child.terminate.assert_called_once()
        self.assertFalse(self.loopback.ready)

    def test_a_client_that_never_plays_is_retried_more_slowly_each_time(self) -> None:
        # A client that starts and dies without reaching the graph would
        # otherwise be respawned ten times a second for as long as it kept
        # failing, which on a small board costs more than the input is worth.
        settle = self.loopback.retry_seconds
        self.child.poll.return_value = 1
        delays: list[float] = []
        for _ in range(4):
            self.loopback.reconcile(self.source, self.sink)
            delays.append(self.loopback.retry_seconds)
        # The first spawn is a fresh start, not a failure; each death after it
        # doubles the wait.
        self.assertEqual(delays, [settle, settle * 2, settle * 4, settle * 8])
        self.assertEqual(self.spawn.call_count, 4)

        # Reaching the graph says the fault did not repeat, so the next one
        # starts its own count rather than inheriting this one's patience.
        self.child.poll.return_value = None
        self.publish()
        self.loopback.reconcile(self.source, self.sink)
        self.assertTrue(self.loopback.ready)
        self.assertEqual(self.loopback.retry_seconds, settle)

    def test_a_moved_target_is_not_charged_for_the_old_ones_failures(self) -> None:
        self.child.poll.return_value = 1
        for _ in range(3):
            self.loopback.reconcile(self.source, self.sink)
        self.assertGreater(self.loopback.retry_seconds, 0.1)
        self.loopback.reconcile(self.source, node("music", 3))
        self.assertEqual(self.loopback.retry_seconds, 0.1)


class InputTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.view = graph.Graph()
        self.source = node("gadget", 1)
        self.sink = node("music", 2)
        self.listings: dict[str, list[graph.Node]] = {
            "sources": [self.source], "sinks": [self.sink], "cards": [],
        }
        listing: Callable[[str], list[graph.Node]] = lambda kind: self.listings.get(kind, [])
        self.contexts.enter_context(mock.patch.object(pactl, "list_json", side_effect=listing))

    def watch_loopback(self, entry: Any) -> tuple[mock.Mock, mock.Mock]:
        play = self.contexts.enter_context(mock.patch.object(entry._loopback, "reconcile"))
        halt = self.contexts.enter_context(mock.patch.object(entry._loopback, "stop"))
        return play, halt


class UsbGadgetInputTests(InputTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.entry = UsbGadgetInput("usb", InputConfig("usb_gadget", "gadget", 20), self.view)
        self.attached = self.contexts.enter_context(mock.patch.object(gadget, "host_attached", return_value=True))
        self.streaming = self.contexts.enter_context(mock.patch.object(gadget, "streaming", return_value=False))
        self.contexts.enter_context(mock.patch.object(gadget, "card_present", return_value=False))
        self.play, self.halt = self.watch_loopback(self.entry)

    def test_enumeration_alone_never_connects_and_stream_stop_disconnects(self) -> None:
        self.entry.reconcile(self.sink, awake=True)
        self.play.assert_not_called()
        self.assertEqual(self.entry.status(), {
            "host": True, "streaming": False, "node": "gadget", "playing": False,
        })
        self.streaming.return_value = True
        self.entry.reconcile(self.sink, awake=True)
        self.play.assert_called_once_with(self.source, self.sink)
        self.play.reset_mock()
        self.halt.reset_mock()
        self.streaming.return_value = False
        self.entry.reconcile(self.sink, awake=True)
        self.play.assert_not_called()
        self.halt.assert_called()
        self.assertFalse(self.entry.streaming)

    def test_the_host_stream_is_bridged_even_while_the_manager_is_idle(self) -> None:
        # The manager's toggle is a mute it applies to the stream; the clock
        # is live while the host streams, so the loopback runs regardless.
        self.streaming.return_value = True
        self.entry.reconcile(self.sink, awake=False)
        self.play.assert_called_once_with(self.source, self.sink)

    def test_a_missing_bus_stops_the_loopback(self) -> None:
        self.streaming.return_value = True
        self.entry.reconcile(None, awake=True)
        self.play.assert_not_called()
        self.halt.assert_called()
        self.assertIsNone(self.entry.retry_seconds)

    def test_parked_card_is_activated_without_connecting_a_dead_clock(self) -> None:
        self.listings["sources"] = []
        self.listings["cards"] = [{"name": "gadget", "active_profile": "off", "profiles": {"off": {}, "pro-audio": {}}}]
        with mock.patch.object(pactl, "set_card_profile") as activate:
            self.entry.reconcile(self.sink, awake=True)
        activate.assert_called_once_with("gadget", "pro-audio")
        self.play.assert_not_called()

    def test_the_host_mixer_is_agreed_with_the_bus_only_while_a_host_is_attached(self) -> None:
        with mock.patch.object(self.entry._volume, "sync") as sync:
            self.entry.reconcile(self.sink, awake=True)
            sync.assert_called_once_with(self.sink, self.view)
            self.attached.return_value = False
            self.entry.reconcile(self.sink, awake=True)
            self.assertEqual(sync.call_args, mock.call(None, self.view))


class CaptureInputTests(InputTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.source.update(name="adc", description="HiFiBerry ADC")
        self.entry = CaptureInput("aux", InputConfig("capture", "HiFiBerry", 20), self.view)
        self.play, self.halt = self.watch_loopback(self.entry)

    def test_the_capture_is_bridged_while_awake_and_dropped_while_idle(self) -> None:
        # Aux has no stream to gate on: its loopback runs whenever the manager
        # keeps the graph up, and the manager holds it silent while it is
        # off. Idle drops it, or it would keep the card clocked for nothing.
        self.entry.reconcile(self.sink, awake=True)
        self.play.assert_called_once_with(self.source, self.sink)
        self.assertEqual(self.entry.status(), {"node": "adc", "playing": False})
        self.play.reset_mock()
        self.entry.reconcile(self.sink, awake=False)
        self.play.assert_not_called()
        self.halt.assert_called()

    def test_a_parked_card_is_only_activated_while_awake(self) -> None:
        self.listings["sources"] = []
        self.listings["cards"] = [{"name": "adc_card", "description": "HiFiBerry", "active_profile": "off", "profiles": {"off": {}, "pro-audio": {}}}]
        with mock.patch.object(pactl, "set_card_profile") as activate:
            self.entry.reconcile(self.sink, awake=False)
            activate.assert_not_called()
            self.entry.reconcile(self.sink, awake=True)
        activate.assert_called_once_with("adc_card", "pro-audio")
        self.play.assert_not_called()


class DaemonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        directory = self.contexts.enter_context(tempfile.TemporaryDirectory())
        self.path = Path(directory)
        self.daemon = AudioInputs(InputsConfig.from_mapping({
            "sink_name": "music", "latency_ms": 20,
            "audio_status": str(self.path / "manager.json"),
            "inputs": {"usb": {"kind": "usb_gadget", "match": "gadget"},
                       "aux": {"kind": "capture", "match": "adc"}},
        }), self.path / "status.json")
        self.addCleanup(self.daemon.selector.close)
        self.sink = node("music", 2)
        self.listings: dict[str, list[graph.Node]] = {
            "sources": [node("gadget", 1), node("adc", 3)], "sinks": [self.sink], "cards": [],
        }
        listing: Callable[[str], list[graph.Node]] = lambda kind: self.listings.get(kind, [])
        self.contexts.enter_context(mock.patch.object(pactl, "list_json", side_effect=listing))
        self.contexts.enter_context(mock.patch.object(gadget, "host_attached", return_value=True))
        self.contexts.enter_context(mock.patch.object(gadget, "streaming", return_value=True))
        self.contexts.enter_context(mock.patch.object(gadget, "card_present", return_value=False))
        self.reconciles = {
            name: self.contexts.enter_context(mock.patch.object(entry, "reconcile"))
            for name, entry in self.daemon.inputs.items()
        }
        self.stops = {
            name: self.contexts.enter_context(mock.patch.object(entry, "stop"))
            for name, entry in self.daemon.inputs.items()
        }
        self.manager_says({"music_bus": {"sink": "music"}, "idle": False})

    def manager_says(self, document: dict[str, Any] | None) -> None:
        if document is None:
            self.daemon.config.audio_status.unlink(missing_ok=True)
        else:
            self.daemon.config.audio_status.write_text(json.dumps(document))

    def test_every_input_sees_the_same_bus_and_the_managers_idle_state(self) -> None:
        self.daemon.reconcile()
        for reconcile in self.reconciles.values():
            reconcile.assert_called_once_with(self.sink, True)
        self.manager_says({"music_bus": {"sink": "music"}, "idle": True})
        self.daemon.reconcile()
        for reconcile in self.reconciles.values():
            self.assertEqual(reconcile.call_args, mock.call(self.sink, False))

    def test_an_unpublished_or_missing_bus_gives_the_inputs_nothing_to_play_into(self) -> None:
        # Until a fresh manager has seeded the bus nothing may play into it,
        # and a bus the manager names but the graph lacks is the same.
        for document in (None, {"music_bus": {"sink": "other"}}, {"music_bus": {"sink": "music"}}):
            self.manager_says(document)
            if document and document["music_bus"]["sink"] == "music":
                self.listings["sinks"] = []
            self.daemon.reconcile()
            for reconcile in self.reconciles.values():
                self.assertIsNone(reconcile.call_args.args[0])

    def test_status_lists_every_input_by_name(self) -> None:
        self.daemon.safe_reconcile()
        published = json.loads(self.daemon.status_path.read_text())
        self.assertEqual(set(published["inputs"]), {"usb", "aux"})
        self.assertEqual(set(published["inputs"]["usb"]), {"host", "streaming", "node", "playing"})
        self.assertEqual(set(published["inputs"]["aux"]), {"node", "playing"})

    def test_failed_reconcile_withdraws_status_stops_every_input_and_retries(self) -> None:
        self.daemon.status_path.write_text("{}")
        self.reconciles["aux"].side_effect = OSError("gone")
        with self.assertLogs("audio_inputs.daemon"):
            self.daemon.safe_reconcile()
        self.assertFalse(self.daemon.status_path.exists())
        for stop in self.stops.values():
            stop.assert_called()
        self.reconciles["aux"].side_effect = None
        self.daemon.safe_reconcile()
        self.assertTrue(self.daemon.status_path.exists())

    def test_shutdown_releases_every_input_and_the_status_even_after_loop_failure(self) -> None:
        with mock.patch.object(
            self.daemon, "safe_reconcile", side_effect=RuntimeError("loop failed")
        ), mock.patch.object(self.daemon.graph_events, "stop") as graph_stop:
            monitor_stops = [
                self.contexts.enter_context(mock.patch.object(monitor, "stop"))
                for monitor in self.daemon.monitors
            ]
            with self.assertRaisesRegex(RuntimeError, "loop failed"):
                self.daemon.execute()
        for stop in self.stops.values():
            stop.assert_called_once()
        graph_stop.assert_called_once()
        self.assertEqual(len(monitor_stops), 1)
        for stop in monitor_stops:
            stop.assert_called_once()
        self.assertFalse(self.daemon.status_path.exists())

    def test_an_unknown_kind_is_refused_at_startup(self) -> None:
        with self.assertRaisesRegex(ValueError, "phono"):
            AudioInputs(InputsConfig.from_mapping({
                "audio_status": str(self.path / "manager.json"),
                "inputs": {"phono": {"kind": "turntable", "match": "x"}},
            }), self.path / "status.json")
