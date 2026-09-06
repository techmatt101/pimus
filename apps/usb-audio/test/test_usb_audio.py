from __future__ import annotations
# pyright: reportPrivateUsage=false

import json
from contextlib import ExitStack
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).parents[3] / "libs/audio-common/src"))

from smartamp_audio import graph, pactl
from usb_audio import gadget
from usb_audio.config import UsbConfig
from usb_audio.daemon import UsbAudio
from usb_audio.playback import Playback
from usb_audio.volume_sync import UsbVolumeSync


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


class PlaybackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.view = graph.Graph()
        self.playback = Playback(self.view, 40)
        self.child = mock.Mock()
        self.child.poll.return_value = None
        self.spawn = self.contexts.enter_context(mock.patch("usb_audio.playback.subprocess.Popen", return_value=self.child))
        self.streams: list[graph.Node] = []
        listing: Callable[[str], list[graph.Node]] = lambda _: self.streams
        self.contexts.enter_context(mock.patch.object(pactl, "list_json", side_effect=listing))
        self.source = node("gadget", 1)
        self.sink = node("music", 2)
        self.writes: list[tuple[str, int, object]] = []
        level_write: Callable[[int, int], None] = lambda index, value: self.writes.append(("volume", index, value))
        mute_write: Callable[[int, bool], None] = lambda index, value: self.writes.append(("mute", index, value))
        self.volume = self.contexts.enter_context(mock.patch.object(
            pactl, "set_sink_input_volume", side_effect=level_write))
        self.mute = self.contexts.enter_context(mock.patch.object(
            pactl, "set_sink_input_mute", side_effect=mute_write))

    def publish(self) -> None:
        self.streams[:] = [{**node("stream", 20, 0, True), "properties": {
            "node.name": self.playback._node_name,
        }}]
        self.view.invalidate()

    def test_stream_starts_muted_and_only_unmutes_after_trim_lands(self) -> None:
        self.playback.reconcile(self.source, self.sink, 25)
        args = self.spawn.call_args.args[0]
        props = json.loads(args[args.index("--playback-props") + 1])
        self.assertEqual(props["node.param.Props"], {"mute": True, "channelVolumes": [0.0, 0.0]})
        self.assertEqual(props["smartamp.volume.owner"], "client")
        for option in ("--capture-props", "--playback-props"):
            properties = json.loads(args[args.index(option) + 1])
            self.assertTrue(properties["node.dont-fallback"])
            self.assertTrue(properties["node.dont-reconnect"])
            self.assertFalse(properties["state.restore-props"])
        self.assertFalse(self.playback.ready)
        self.assertEqual(self.writes, [])
        self.publish()
        self.playback.reconcile(self.source, self.sink, 25)
        self.assertEqual(self.writes, [("volume", 20, 25), ("mute", 20, False)])
        self.assertTrue(self.playback.ready)
        self.spawn.assert_called_once()

    def test_failed_trim_keeps_the_new_stream_muted(self) -> None:
        self.playback.reconcile(self.source, self.sink, 25)
        self.publish()
        self.volume.side_effect = OSError("stream not ready")
        with self.assertRaises(OSError):
            self.playback.reconcile(self.source, self.sink, 25)
        self.mute.assert_not_called()
        self.assertFalse(self.playback.ready)

    def test_recreated_target_reaps_old_client_and_ignores_its_stream(self) -> None:
        self.playback.reconcile(self.source, self.sink, 25)
        self.publish()
        self.playback.reconcile(self.source, node("music", 3), 25)
        self.child.terminate.assert_called_once()
        self.child.wait.assert_called_once()
        self.assertEqual(self.spawn.call_count, 2)
        self.assertFalse(self.playback.ready)
        self.assertEqual(self.writes, [])

    def test_exited_client_is_restarted_and_stop_releases_it(self) -> None:
        self.playback.reconcile(self.source, self.sink, 25)
        self.child.poll.return_value = 1
        self.playback.reconcile(self.source, self.sink, 25)
        self.assertEqual(self.spawn.call_count, 2)
        self.child.poll.return_value = None
        self.playback.stop()
        self.child.terminate.assert_called_once()
        self.assertFalse(self.playback.ready)

    def test_a_client_that_never_plays_is_retried_more_slowly_each_time(self) -> None:
        # A client that starts and dies without reaching the graph would
        # otherwise be respawned ten times a second for as long as it kept
        # failing, which on a small board costs more than the route is worth.
        settle = self.playback.retry_seconds
        self.child.poll.return_value = 1
        delays: list[float] = []
        for _ in range(4):
            self.playback.reconcile(self.source, self.sink, 25)
            delays.append(self.playback.retry_seconds)
        # The first spawn is a fresh start, not a failure; each death after it
        # doubles the wait.
        self.assertEqual(delays, [settle, settle * 2, settle * 4, settle * 8])
        self.assertEqual(self.spawn.call_count, 4)

        # Reaching the graph says the fault did not repeat, so the next one
        # starts its own count rather than inheriting this one's patience.
        self.child.poll.return_value = None
        self.publish()
        self.playback.reconcile(self.source, self.sink, 25)
        self.assertTrue(self.playback.ready)
        self.assertEqual(self.playback.retry_seconds, settle)

    def test_a_moved_target_is_not_charged_for_the_old_ones_failures(self) -> None:
        self.child.poll.return_value = 1
        for _ in range(3):
            self.playback.reconcile(self.source, self.sink, 25)
        self.assertGreater(self.playback.retry_seconds, 0.1)
        self.playback.reconcile(self.source, node("music", 3), 25)
        self.assertEqual(self.playback.retry_seconds, 0.1)


class UsbLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        directory = self.contexts.enter_context(tempfile.TemporaryDirectory())
        self.path = Path(directory)
        self.client = UsbAudio(UsbConfig.from_mapping({
            "source_match": "gadget", "sink_name": "music", "enabled": True,
            "audio_status": str(self.path / "manager.json"),
        }), self.path / "control.sock", self.path / "status.json")
        self.addCleanup(self.client.selector.close)
        self.source = node("gadget", 1)
        self.sink = node("music", 2)
        self.listings: dict[str, list[graph.Node]] = {
            "sources": [self.source], "sinks": [self.sink], "cards": [],
        }
        listing: Callable[[str], list[graph.Node]] = lambda kind: self.listings.get(kind, [])
        self.contexts.enter_context(mock.patch.object(pactl, "list_json", side_effect=listing))
        self.modules = self.contexts.enter_context(mock.patch.object(pactl, "list_modules", return_value=[]))
        self.attached = self.contexts.enter_context(mock.patch.object(gadget, "host_attached", return_value=True))
        self.streaming = self.contexts.enter_context(mock.patch.object(gadget, "streaming", return_value=False))
        self.contexts.enter_context(mock.patch.object(gadget, "card_present", return_value=False))
        self.play = self.contexts.enter_context(mock.patch.object(self.client.playback, "reconcile"))
        self.halt = self.contexts.enter_context(mock.patch.object(self.client.playback, "stop"))
        self.client.config.audio_status.write_text(json.dumps({"background": {"sink": "music"}, "idle": True}))

    def test_enumeration_alone_never_connects_and_stream_stop_disconnects(self) -> None:
        self.client.reconcile()
        self.play.assert_not_called()
        self.assertFalse(self.client.available)
        self.assertTrue(self.client.host.attached)
        self.streaming.return_value = True
        self.client.reconcile()
        self.play.assert_called_once_with(self.source, self.sink, 100)
        self.assertTrue(self.client.available)
        self.play.reset_mock()
        self.halt.reset_mock()
        self.streaming.return_value = False
        self.client.reconcile()
        self.play.assert_not_called()
        self.halt.assert_called()
        self.assertFalse(self.client.host.streaming)
        self.assertTrue(self.client.enabled)

    def test_upgrade_removes_only_the_old_managers_usb_loopback(self) -> None:
        self.modules.return_value = [
            {"index": 1, "name": "module-loopback", "argument": "source=gadget sink=music sink_input_properties=media.name=SmartAmp.usb"},
            {"index": 2, "name": "module-loopback", "argument": "source=aux sink=music sink_input_properties=media.name=SmartAmp.aux"},
            {"index": 3, "name": "module-loopback", "argument": "source=gadget sink=another"},
        ]
        with mock.patch.object(pactl, "unload_module") as unload:
            self.client.reconcile()
            self.client.reconcile()
        unload.assert_called_once_with(1)
        self.modules.assert_called_once()

    def test_toggle_off_stops_playback_while_host_status_stays_visible(self) -> None:
        self.streaming.return_value = True
        self.client.enabled = False
        self.client.reconcile()
        self.play.assert_not_called()
        self.assertTrue(self.client.state_event()["usb_playback"])
        self.assertFalse(self.client.state_event()["sources"]["usb"])

    def test_missing_manager_readiness_or_target_stops_the_client(self) -> None:
        self.streaming.return_value = True
        self.client.config.audio_status.unlink()
        self.client.reconcile()
        self.play.assert_not_called()
        self.halt.assert_called()
        self.client.config.audio_status.write_text('{"background":{"sink":"music"}}')
        self.listings["sinks"] = []
        self.client.reconcile()
        self.play.assert_not_called()

    def test_parked_card_is_activated_without_connecting_a_dead_clock(self) -> None:
        self.listings["sources"] = []
        self.listings["cards"] = [{"name": "gadget", "active_profile": "off", "profiles": {"off": {}, "pro-audio": {}}}]
        with mock.patch.object(pactl, "set_card_profile") as activate:
            self.client.reconcile()
        activate.assert_called_once_with("gadget", "pro-audio")
        self.play.assert_not_called()

    def test_failed_reconcile_withdraws_readiness_stops_playback_and_retries(self) -> None:
        self.client.status_path.write_text('{}')
        with mock.patch.object(self.client, "reconcile", side_effect=OSError("gone")), self.assertLogs("usb_audio.daemon"):
            self.client.safe_reconcile()
        self.assertFalse(self.client.status_path.exists())
        self.halt.assert_called()
        self.client.safe_reconcile()
        self.assertTrue(self.client.status_path.exists())

    def test_shutdown_releases_playback_and_status_even_after_loop_failure(self) -> None:
        with mock.patch.object(self.client.control, "start"), mock.patch.object(
            self.client, "safe_reconcile", side_effect=RuntimeError("loop failed")
        ), mock.patch.object(self.client.graph_events, "stop") as graph_stop, mock.patch.object(
            self.client.mixer_events, "stop"
        ) as mixer_stop:
            with self.assertRaisesRegex(RuntimeError, "loop failed"):
                self.client.execute()
        self.halt.assert_called_once()
        graph_stop.assert_called_once()
        mixer_stop.assert_called_once()
        self.assertFalse(self.client.status_path.exists())

    def test_real_socket_commands_replay_controls_and_reply_to_unchanged_values(self) -> None:
        self.client.control.start()
        self.addCleanup(self.client.control.close)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(connection.close)
        connection.settimeout(1)
        connection.connect(str(self.client.control.socket_path))

        def exchange(message: Any) -> dict[str, Any]:
            connection.sendall(json.dumps(message).encode() + b"\n")
            for _ in range(2):
                for key, _ in self.client.selector.select(0.01):
                    key.data()
            return json.loads(connection.recv(4096))

        self.assertTrue(exchange({"command": "get-state"})["sources"]["usb"])
        for _ in range(2):
            self.assertFalse(exchange({"command": "set-source-state", "name": "usb", "state": "off"})["sources"]["usb"])
            self.assertEqual(exchange({"command": "set-input-trim", "name": "usb", "percent": 25})["trims"]["usb"], 25)
        invalid: list[Any] = [[], {"command": []}, {"command": "set-input-trim", "name": "usb", "percent": True}, {"command": "set-source-state", "name": "usb", "state": []}]
        for bad in invalid:
            self.assertEqual(exchange(bad)["event"], "error")
