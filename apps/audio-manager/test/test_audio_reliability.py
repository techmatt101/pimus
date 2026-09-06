from __future__ import annotations

# These tests drive a few private daemon methods directly, standing where a
# selector callback or the shutdown path would.
# pyright: reportPrivateUsage=false

import json
import socket
from typing import Any
from unittest import mock

from test_audio_manager import (
    Listings,
    ManagerTestCase,
    completed,
    fake_run,
    volume_writes,
)
from smartamp_audio import graph
from smartamp_audio.status import write as write_status


def stereo(left: int, right: int) -> graph.Node:
    return {
        "volume": {
            "front-left": {"value_percent": f"{left}%"},
            "front-right": {"value_percent": f"{right}%"},
        }
    }


class AudioReliabilityTests(ManagerTestCase):
    def test_all_output_channels_are_pinned_to_unity_behind_the_guard(self) -> None:
        sink: graph.Node = {
            "name": "hifi", "description": "HiFiBerry", "index": 1, **stereo(0, 100)
        }
        self.assertEqual(graph.volume_state(sink), (100, False))
        self.assertFalse(graph.volume_is(sink, 100))
        manager = self.make_manager({})
        with self._patched_graph({"sinks": [sink]}, fake_run) as run:
            manager.output.prepare()
        self.assertEqual(
            [call.args for call in run.call_args_list],
            [
                ("pactl", "set-sink-mute", "hifi", "1"),
                ("pactl", "set-sink-volume", "hifi", "100%"),
            ],
        )
        self.assertTrue(manager.output.guarded)

    def test_music_command_updates_direct_clients_immediately(self) -> None:
        manager = self.make_manager({})
        listings: Listings = {
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

    def test_aec_readiness_requires_a_stream_and_repairs_every_channel_and_mute(
        self,
    ) -> None:
        manager = self.make_manager(
            {"echo_reference": {"enabled": True, "sink_match": "XVF"}}
        )
        sink: graph.Node = {"name": "xvf", **stereo(0, 100), "mute": False}
        listings: Listings = {
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
            status = manager.echo_reference.reconcile({"name": "hifi"})
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
            status = manager.echo_reference.reconcile({"name": "hifi"})
        self.assertTrue(status["available"])
        self.assertIn(
            mock.call("pactl", "set-sink-input-volume", "5", "100%"), run.call_args_list
        )
        self.assertIn(
            mock.call("pactl", "set-sink-input-mute", "5", "0"), run.call_args_list
        )

        with self._patched_graph(listings, fake_run):
            status = manager.echo_reference.reconcile({"name": "hifi"}, wanted=False)
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
        self.sink: graph.Node = {
            "name": "hifiberry",
            "description": "HiFiBerry",
            "index": 1,
            "mute": False,
            **stereo(80, 80),
        }
        self.stream: graph.Node = {
            "index": 51,
            "owner_module": 50,
            "properties": {"media.name": "SmartAmp.aux"},
            **stereo(100, 100),
        }
        self.listings: Listings = {
            "sinks": [self.sink],
            "sources": [{"name": "adc", "description": "ADC"}],
            "sink-inputs": [],
            "modules": [],
        }
        self.calls: list[tuple[str, ...]] = []
        self.publish_stream = True
        self.fail_gain = False
        self.fail_unmute = False
        patches = [
            self._patched_graph(self.listings, self.run_command),
            mock.patch("smartamp_audio.status.write"),
        ]
        for patch in patches:
            patch.__enter__()
            self.addCleanup(patch.__exit__, None, None, None)

    def run_command(self, *args: str, check: bool = True) -> Any:
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
            if self.fail_unmute and args[3] == "0":
                raise RuntimeError("unmute write failed")
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

    def test_failed_gain_keeps_output_muted_until_recovery(self) -> None:
        self.fail_gain = True
        self.stream.update(stereo(100, 100))
        self.manager.output.find()
        self.manager.output.guard()
        with self.assertLogs("audio_manager.daemon", level="WARNING"):
            self.assertFalse(self.manager.safe_reconcile())
        self.assertTrue(self.sink["mute"])
        self.fail_gain = False
        self.assertTrue(self.manager.safe_reconcile())
        self.assertFalse(self.sink["mute"])

    def test_unpublished_route_keeps_the_guard_and_the_rest_of_the_pass(self) -> None:
        # The stream not being listed yet is not a failure: the pass completes,
        # publishes, and books a retry, with the output held muted meanwhile.
        self.publish_stream = False
        with mock.patch("audio_manager.daemon.time.monotonic", return_value=100.0):
            self.assertTrue(self.manager.safe_reconcile())
        self.assertTrue(self.sink["mute"])
        self.assertEqual(self.manager.pending_reconcile, 101.0)
        self.listings["sink-inputs"].append(self.stream)
        self.assertTrue(self.manager.safe_reconcile())
        self.assertFalse(self.sink["mute"])
        self.assertTrue(graph.volume_is(self.stream, 10))

    def test_a_mute_left_on_the_sink_is_released_once_the_pass_settles(self) -> None:
        # A daemon killed mid-guard, or WirePlumber restoring an old mute,
        # leaves the sink muted with nobody to unmute it: the next daemon owns
        # it, so sound always comes back. Silence is a music level, not a mute.
        self.sink["mute"] = True
        self.manager.reconcile()
        self.assertFalse(self.sink["mute"])
        self._restart_manager()
        self.assertFalse(self.sink["mute"])
        self.sink["mute"] = True
        self.manager.reconcile()
        self.assertFalse(self.sink["mute"])

    def test_failed_unmute_retains_guard_until_the_write_succeeds(self) -> None:
        self.fail_unmute = True
        with self.assertLogs("audio_manager.daemon", level="WARNING"):
            self.assertFalse(self.manager.safe_reconcile())
        self.assertTrue(self.manager.output.guarded)
        self.assertTrue(self.sink["mute"])
        self.fail_unmute = False
        self.assertTrue(self.manager.safe_reconcile())
        self.assertFalse(self.manager.output.guarded)
        self.assertFalse(self.sink["mute"])

    def test_failed_pass_withdraws_status_and_recovery_publishes_again(self) -> None:
        with mock.patch("smartamp_audio.status.write", wraps=write_status):
            self.assertTrue(self.manager.safe_reconcile())
            self.assertTrue(self.manager.status_path.exists())
            self.fail_gain = True
            self.stream.update(stereo(100, 100))
            with self.assertLogs("audio_manager.daemon", level="WARNING"):
                self.assertFalse(self.manager.safe_reconcile())
            self.assertFalse(self.manager.status_path.exists())
            self.fail_gain = False
            self.assertTrue(self.manager.safe_reconcile())
            self.assertEqual(
                json.loads(self.manager.status_path.read_text())["sink"], "hifiberry"
            )

    def _restart_manager(self) -> None:
        self.manager = self.make_manager(
            {
                "startup_volume_percent": 10,
                "sources": {"aux": {"enabled": True, "match": "ADC"}},
            }
        )
        self.manager.reconcile()


class BackgroundRouteSafetyTests(ManagerTestCase):
    def test_delayed_background_route_stream_is_guarded_until_its_trim_applies(self) -> None:
        manager = self.make_manager(
            {
                "startup_volume_percent": 40,
                "background": {"enabled": True},
                "sources": {
                    "line_in": {
                        "enabled": False,
                        "match": "Line input",
                        "target": "background",
                        "volume_percent": 25,
                    }
                },
            }
        )
        sink: graph.Node = {
            "name": "hifiberry", "description": "HiFiBerry", "index": 1,
            "mute": False, **stereo(100, 100),
        }
        stream: graph.Node = {
            "index": 51, "owner_module": 50, "sink": 2,
            "properties": {"media.name": "SmartAmp.line_in"},
            **stereo(100, 100),
        }
        listings: Listings = {
            "sinks": [
                sink,
                {"name": "smartamp_background", "index": 2, "owner_module": 20},
            ],
            "sources": [
                {"name": "smartamp_background.monitor"},
                {"name": "line_in", "description": "Line input"},
            ],
            "modules": [
                {"index": 20, "name": "module-null-sink"},
                {
                    "index": 30, "name": "module-loopback",
                    "argument": "source=smartamp_background.monitor sink=hifiberry",
                },
            ],
            "sink-inputs": [
                {"index": 31, "owner_module": 30, "sink": 1, **stereo(40, 40)},
            ],
        }

        def run(*args: str, check: bool = True) -> Any:
            if args[1] == "load-module":
                self.assertTrue(sink["mute"])
                listings["modules"].append(
                    {"index": 50, "name": args[2], "argument": " ".join(args[3:])}
                )
                return completed(*args, stdout="50\n")
            if args[1] == "set-sink-mute":
                sink["mute"] = args[3] == "1"
            if args[1] == "set-sink-input-volume" and args[2] == "51":
                self.assertTrue(sink["mute"])
                level = int(args[3][:-1])
                stream.update(stereo(level, level))
            return fake_run(*args, check=check)

        with self._patched_graph(listings, run):
            manager.reconcile()
            manager.routes.enabled["line_in"] = True
            self.assertTrue(manager.safe_reconcile())
            self.assertFalse(manager.routes.settled)
            self.assertTrue(sink["mute"])
            self.assertIsNotNone(manager.pending_reconcile)
            self.assertTrue(manager.status_path.exists())
            listings["sink-inputs"].append(stream)
            self.assertTrue(manager.safe_reconcile())
            self.assertTrue(graph.volume_is(stream, 25))
            self.assertTrue(manager.routes.settled)
            self.assertFalse(sink["mute"])
