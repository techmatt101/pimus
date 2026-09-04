from __future__ import annotations

import json
import socket
import tempfile
from pathlib import Path
from unittest import mock

from test_audio_manager import ManagerTestCase, completed, fake_run, volume_writes
from audio_manager import graph, output
from audio_manager.config import AudioConfig
from audio_manager.system import pactl, usb_gadget


def stereo(left: int, right: int) -> dict:
    return {
        "volume": {
            "front-left": {"value_percent": f"{left}%"},
            "front-right": {"value_percent": f"{right}%"},
        }
    }


class AudioReliabilityTests(ManagerTestCase):
    def test_all_output_channels_are_pinned_to_unity(self) -> None:
        sink = {"name": "hifi", **stereo(0, 100)}
        self.assertEqual(graph.volume_state(sink), (100, False))
        self.assertFalse(graph.volume_is(sink, 100))
        with mock.patch.object(pactl, "set_sink_volume") as write:
            output.pin_volume(sink)
        write.assert_called_once_with("hifi", 100)

    def test_music_command_updates_direct_clients_immediately(self) -> None:
        manager = self.make_manager({})
        listings = {
            "sinks": [{"index": 1, "name": "hifi", "description": "HiFiBerry"}],
            "sink-inputs": [
                {"index": 10, "sink": 1, **stereo(50, 100)},
                {"index": 11, "sink": 2, **stereo(100, 100)},
                {
                    "index": 12,
                    "sink": 1,
                    "properties": {"media.name": "SmartAmp.voice_bridge"},
                },
            ],
        }
        with self._patched_graph(listings, fake_run) as run:
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-music-volume", "percent": 25}
            )
        self.assertEqual(reply["music_volume"], 25)
        self.assertFalse(reconcile)
        self.assertEqual(volume_writes(run), [("10", "25%")])

    def test_malformed_socket_messages_do_not_break_the_next_command(self) -> None:
        manager = self.make_manager({})
        connection, client = socket.socketpair()
        self.addCleanup(connection.close)
        self.addCleanup(client.close)
        client.settimeout(1)
        for line in (
            b'{"command": []}',
            b'{"command": {}}',
            b"\xff",
            b"[" * 2000 + b"]" * 2000,
        ):
            with self.subTest(line=line[:40]):
                manager.control._handle(connection, line)
                self.assertEqual(json.loads(client.recv(4096))["event"], "error")
                manager.control._handle(connection, b'{"command":"get-state"}')
                self.assertEqual(json.loads(client.recv(4096))["event"], "state")

    def test_immediate_reconcile_advances_an_existing_deadline(self) -> None:
        manager = self.make_manager({})
        with mock.patch("audio_manager.daemon.time.monotonic", return_value=100.0):
            manager.schedule_reconcile(0.3)
            manager.schedule_reconcile(0.0)
            manager.schedule_reconcile(0.3)
        self.assertEqual(manager.pending_reconcile, 100.0)

    def test_invalid_capture_channels_are_rejected(self) -> None:
        for channel in (-1, True, 1.5, "1"):
            with self.subTest(channel=channel), self.assertRaisesRegex(
                ValueError, "voice_capture_channel"
            ):
                AudioConfig.from_mapping({"voice_capture_channel": channel})

    def test_unpublished_capture_remap_does_not_fall_back_to_stereo(self) -> None:
        manager = self.make_manager({"voice_capture_channel": 1})
        device = {"name": "xvf", "channel_map": "front-left,front-right"}
        with self._patched_graph({}, fake_run), mock.patch.object(
            pactl, "load_module", return_value=1
        ):
            source, status = manager.microphone.reconcile(device)
        self.assertIsNone(source)
        self.assertEqual(status, {"channel": 1, "source": None})

    def test_aec_readiness_requires_a_stream_and_repairs_every_channel_and_mute(
        self,
    ) -> None:
        manager = self.make_manager(
            {"aec_reference": {"enabled": True, "sink_match": "XVF"}}
        )
        sink = {"name": "xvf", **stereo(0, 100), "mute": False}
        listings = {
            "sinks": [sink],
            "sources": [{"name": "hifi.monitor"}],
            "modules": [
                {
                    "index": 4,
                    "name": "module-loopback",
                    "argument": "source=hifi.monitor sink=xvf",
                }
            ],
            "sink-inputs": [],
        }
        with self._patched_graph(listings, fake_run) as run:
            status = manager.aec_reference.reconcile({"name": "hifi"})
        self.assertTrue(status["endpoints_available"])
        self.assertFalse(status["available"])
        self.assertIn(
            mock.call("pactl", "set-sink-volume", "xvf", "100%"), run.call_args_list
        )

        listings["sink-inputs"] = [
            {"index": 5, "owner_module": 4, **stereo(0, 100), "mute": True}
        ]
        manager.graph.invalidate()
        with self._patched_graph(listings, fake_run) as run:
            status = manager.aec_reference.reconcile({"name": "hifi"})
        self.assertTrue(status["available"])
        self.assertIn(
            mock.call("pactl", "set-sink-input-volume", "5", "100%"), run.call_args_list
        )
        self.assertIn(
            mock.call("pactl", "set-sink-input-mute", "5", "0"), run.call_args_list
        )

        with self._patched_graph(listings, fake_run):
            status = manager.aec_reference.reconcile({"name": "hifi"}, wanted=False)
        self.assertTrue(status["endpoints_available"])
        self.assertFalse(status["available"])


class RebuildSafetyTests(ManagerTestCase):
    def setUp(self) -> None:
        self.manager = self.make_manager(
            {
                "startup_volume_percent": 10,
                "sources": {"aux": {"enabled": True, "match": "ADC"}},
            }
        )
        self.sink = {
            "name": "hifiberry",
            "description": "HiFiBerry",
            "index": 1,
            "mute": False,
            **stereo(80, 80),
        }
        self.stream = {
            "index": 51,
            "owner_module": 50,
            "properties": {"media.name": "SmartAmp.aux"},
            **stereo(100, 100),
        }
        self.listings = {
            "sinks": [self.sink],
            "sources": [{"name": "adc", "description": "ADC"}],
            "sink-inputs": [],
            "modules": [],
        }
        self.calls = []
        self.publish_stream = True
        self.fail_gain = False
        patches = [
            self._patched_graph(self.listings, self.run_command),
            mock.patch.object(usb_gadget, "card_present", return_value=False),
            mock.patch.object(self.manager.usb, "refresh"),
            mock.patch("audio_manager.status.write"),
        ]
        for patch in patches:
            patch.__enter__()
            self.addCleanup(patch.__exit__, None, None, None)

    def run_command(self, *args: str, check: bool = True):
        self.calls.append(args)
        command = args[1]
        if command == "load-module":
            self.listings["modules"].append(
                {"index": 50, "name": args[2], "argument": " ".join(args[3:])}
            )
            if self.publish_stream:
                self.listings["sink-inputs"].append(self.stream)
            return completed(*args, stdout="50\n")
        if command == "set-sink-mute":
            self.sink["mute"] = args[3] == "1"
        if command == "set-sink-volume":
            self.sink.update(stereo(int(args[3][:-1]), int(args[3][:-1])))
        if command == "set-sink-input-volume":
            if self.fail_gain:
                raise RuntimeError("gain write failed")
            self.stream.update(stereo(int(args[3][:-1]), int(args[3][:-1])))
        return fake_run(*args, check=check)

    def test_boot_protects_before_pinning_or_connecting_and_settled_pass_does_not_mute(
        self,
    ) -> None:
        self.manager.reconcile()
        commands = [call[1] for call in self.calls]
        self.assertLess(
            commands.index("set-sink-mute"), commands.index("set-sink-volume")
        )
        self.assertLess(commands.index("set-sink-mute"), commands.index("load-module"))
        self.assertEqual(self.calls[-1], ("pactl", "set-sink-mute", "hifiberry", "0"))
        self.assertTrue(graph.volume_is(self.stream, 10))
        self.calls.clear()
        self.manager.reconcile()
        self.assertFalse(any(call[1].startswith("set-") for call in self.calls))

    def test_connecting_a_route_while_active_is_also_protected(self) -> None:
        self.manager.routes.enabled["aux"] = False
        self.manager.reconcile()
        self.calls.clear()
        self.manager.routes.enabled["aux"] = True
        self.manager.reconcile()
        commands = [call[1] for call in self.calls]
        self.assertLess(commands.index("set-sink-mute"), commands.index("load-module"))
        self.assertFalse(self.sink["mute"])

    def test_failed_gain_keeps_output_muted_and_recovery_restores_requested_mute(
        self,
    ) -> None:
        for desired_mute in (False, True):
            with self.subTest(
                desired_mute=desired_mute
            ), tempfile.TemporaryDirectory() as directory:
                self.manager.status_path = Path(directory) / "status.json"
                self.manager.status_path.write_text('{"sink":"stale"}')
                self.fail_gain = True
                self.stream.update(stereo(100, 100))
                self.manager.output_guard.protect(self.sink)
                with self.assertLogs("audio_manager.daemon", level="WARNING"):
                    self.assertFalse(self.manager.safe_reconcile())
                self.assertFalse(self.manager.status_path.exists())
                self.assertTrue(self.sink["mute"])
                self.manager.set_output_mute(desired_mute)
                self.assertTrue(self.sink["mute"])
                self.fail_gain = False
                self.assertTrue(self.manager.safe_reconcile())
                self.assertEqual(self.sink["mute"], desired_mute)
                self.assertEqual(self.manager.output_muted, desired_mute)

    def test_unpublished_route_stays_muted_until_its_gain_can_be_written(self) -> None:
        self.publish_stream = False
        with self.assertLogs("audio_manager.daemon", level="WARNING"):
            self.assertFalse(self.manager.safe_reconcile())
        self.assertTrue(self.sink["mute"])
        self.listings["sink-inputs"].append(self.stream)
        self.assertTrue(self.manager.safe_reconcile())
        self.assertFalse(self.sink["mute"])
        self.assertTrue(graph.volume_is(self.stream, 10))
