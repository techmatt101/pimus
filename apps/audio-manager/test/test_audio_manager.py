from __future__ import annotations

import array
import contextlib
import json
import os
import selectors
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from audio_manager import (  # noqa: E402
    control_server,
    graph,
    levels,
    monitors,
    output,
    pactl,
    process,
    usb_gadget,
    volume,
)
from audio_manager.config import AudioConfig  # noqa: E402
from audio_manager.daemon import AudioManager  # noqa: E402
from audio_manager.idle import IdleTracker  # noqa: E402


def completed(*args: str, returncode: int = 0, stdout: str = "") -> Any:
    return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr="")


def fake_run(*args: str, check: bool = True) -> Any:
    defaults = {"get-default-sink": "hifiberry", "get-default-source": "xvf_mic"}
    stdout = next((name + "\n" for key, name in defaults.items() if key in args), "")
    return completed(*args, stdout=stdout)


def volume_writes(run: mock.Mock) -> list[tuple[str, str]]:
    return [
        (call.args[2], call.args[3])
        for call in run.call_args_list
        if "set-sink-input-volume" in call.args
    ]


class ManagerTestCase(unittest.TestCase):
    def make_manager(self, raw_config: dict[str, Any]) -> AudioManager:
        base = {
            "output_match": "HiFiBerry",
            "voice_input_match": "XVF3800",
            "sources": {},
        }
        manager = AudioManager(
            AudioConfig.from_mapping({**base, **raw_config}),
            Path("/unused/control.sock"),
            Path("/unused/status.json"),
        )
        self.addCleanup(manager.selector.close)
        return manager

    @staticmethod
    @contextlib.contextmanager
    def _patched_graph(listings: dict[str, Any], run: Any) -> Any:
        """Answer every graph listing from a dict, and every command from run."""
        with mock.patch.object(
            pactl, "list_json", side_effect=lambda kind: listings.get(kind, [])
        ), mock.patch.object(
            pactl, "list_modules", side_effect=lambda: listings.get("modules", [])
        ), mock.patch.object(process, "run", side_effect=run) as run_mock:
            yield run_mock


class GraphMatchingTests(unittest.TestCase):
    def test_device_match_ignores_sink_monitor(self) -> None:
        nodes = [
            {
                "name": "alsa_output.usb-XVF3800.monitor",
                "description": "Monitor of reSpeaker XVF3800",
                "monitor_of_sink": 42,
            },
            {
                "name": "alsa_input.usb-XVF3800",
                "description": "reSpeaker XVF3800 Mic Array",
                "monitor_of_sink": 4294967295,
            },
        ]
        selected = graph.find_node(nodes, "XVF3800")
        self.assertEqual(selected["name"], "alsa_input.usb-XVF3800")

    def test_device_match_searches_properties(self) -> None:
        nodes = [
            {
                "name": "source.1",
                "properties": {"device.product.name": "HiFiBerry DAC2 ADC Pro"},
            }
        ]
        selected = graph.find_node(nodes, "HiFiBerry")
        self.assertEqual(selected["name"], "source.1")

    def test_owned_stream_matches_numeric_or_string_module_id(self) -> None:
        streams = [
            {"index": 10, "owner_module": 7},
            {"index": 11, "owner_module": "8"},
        ]
        self.assertEqual(graph.find_owned_stream(streams, 8)["index"], 11)
        self.assertIsNone(graph.find_owned_stream(streams, 9))

        tagged = [
            {"index": 12, "properties": {"media.name": "SmartAmp.background_bridge"}}
        ]
        self.assertEqual(
            graph.find_owned_stream(tagged, 8, "SmartAmp.background_bridge")["index"],
            12,
        )

    def test_loaded_module_matches_required_route_arguments(self) -> None:
        modules = [
            {
                "index": 12,
                "name": "module-loopback",
                "argument": "source=background.monitor sink=hifiberry latency_msec=40",
            }
        ]
        selected = graph.find_loaded_module(
            modules,
            "module-loopback",
            ("source=background.monitor", "sink=hifiberry"),
        )
        self.assertEqual(selected["index"], 12)

    def test_module_listing_parses_indices_and_multiline_arguments(self) -> None:
        # pactl 17's JSON module listing has no index field, so the manager
        # reads `pactl list short modules`, where a module's argument block can
        # continue over several lines.
        listing = (
            "1\tlibpipewire-module-rt\t{\n"
            "            nice.level    = -11\n"
            "            rt.prio       = 88\n"
            "        }\t\n"
            "536870912\tmodule-loopback\tsource=background.monitor sink=hifiberry latency_msec=40\t\n"
        )
        with mock.patch.object(
            process, "run", return_value=completed("pactl", stdout=listing)
        ):
            modules = pactl.list_modules()

        self.assertEqual([module["index"] for module in modules], [1, 536870912])
        selected = graph.find_loaded_module(
            modules,
            "module-loopback",
            ("source=background.monitor", "sink=hifiberry"),
        )
        self.assertEqual(selected["index"], 536870912)


class ProcessTests(unittest.TestCase):
    def test_short_commands_have_a_timeout(self) -> None:
        result = completed("pactl")
        with mock.patch.object(subprocess, "run", return_value=result) as run:
            self.assertIs(process.run("pactl", "info"), result)

        run.assert_called_once_with(
            ("pactl", "info"),
            check=True,
            text=True,
            capture_output=True,
            timeout=process.COMMAND_TIMEOUT_SECONDS,
        )

    def test_server_readiness_treats_a_timeout_as_not_ready(self) -> None:
        with mock.patch.object(
            process,
            "run",
            side_effect=subprocess.TimeoutExpired(("pactl", "info"), 5),
        ):
            self.assertFalse(pactl.server_ready())


class ControlSocketTests(ManagerTestCase):
    def test_route_state_defaults_follow_config(self) -> None:
        manager = self.make_manager(
            {"sources": {"aux": {"enabled": True}, "usb": {"enabled": False}}}
        )
        self.assertEqual(manager.routes.enabled, {"aux": True, "usb": False})

    def test_route_commands_update_memory_state(self) -> None:
        manager = self._duckable_manager()
        manager.routes.enabled = {"aux": True, "usb": False}
        connection = mock.Mock()

        reply, reconcile = manager.commands.apply(
            connection, {"command": "set-source", "name": "usb", "state": "toggle"}
        )
        self.assertEqual(
            reply,
            {
                "event": "state",
                "sources": {"aux": True, "usb": True},
                "ducked": False,
                "usb_playback": False,
                "music_volume": 100,
                "voice_volume": 100,
                "output_muted": False,
            },
        )
        self.assertTrue(reconcile)

        # Re-applying the current state must not trigger graph work.
        _, reconcile = manager.commands.apply(
            connection, {"command": "set-source", "name": "usb", "state": "on"}
        )
        self.assertFalse(reconcile)

        reply, reconcile = manager.commands.apply(
            connection, {"command": "set-source", "name": "phono", "state": "on"}
        )
        self.assertEqual(reply["event"], "error")
        self.assertFalse(reconcile)

    def test_reconnect_sync_adopts_only_configured_boolean_sources(self) -> None:
        manager = self._duckable_manager()
        manager.routes.enabled = {"aux": True, "usb": False}
        reply, reconcile = manager.commands.apply(
            mock.Mock(),
            {
                "command": "set-sources",
                "sources": {"aux": False, "usb": "yes", "bogus": True},
            },
        )
        # Unknown routes and non-boolean values are ignored, not coerced.
        self.assertEqual(reply["sources"], {"aux": False, "usb": False})
        self.assertTrue(reconcile)

    def test_socket_commands_reconcile_and_answer_with_live_state(self) -> None:
        manager = self._duckable_manager()
        manager.routes.enabled = {"aux": False}
        manager.safe_reconcile = mock.Mock()
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        left.setblocking(False)
        manager.control.clients = {left: b""}
        manager.selector.register(left, selectors.EVENT_READ, lambda: None)

        right.sendall(b'{"command": "set-source", "name": "aux", "state": "on"}\n')
        manager.control.read(left)

        self.assertEqual(
            json.loads(right.recv(4096)),
            {
                "event": "state",
                "sources": {"aux": True},
                "ducked": False,
                "usb_playback": False,
                "music_volume": 100,
                "voice_volume": 100,
                "output_muted": False,
            },
        )
        manager.safe_reconcile.assert_called_once()

        right.sendall(b"not json\n")
        manager.control.read(left)
        self.assertEqual(json.loads(right.recv(4096))["event"], "error")

    def test_flooding_client_is_dropped(self) -> None:
        manager = self._duckable_manager()
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        left.setblocking(False)
        manager.control.clients = {left: b"x" * control_server.MAX_CLIENT_BUFFER_BYTES}
        manager.selector.register(left, selectors.EVENT_READ, lambda: None)

        right.sendall(b"y")
        manager.control.read(left)
        self.assertEqual(manager.control.clients, {})

    def test_duck_requests_are_held_against_the_requesting_connection(self) -> None:
        manager = self._duckable_manager()
        connection = mock.Mock()

        reply, needs_reconcile = manager.commands.apply(
            connection, {"command": "set-duck", "active": True}
        )
        self.assertTrue(reply["ducked"])
        # Ducking only changes one stream volume, so it must not force a full
        # graph reconcile.
        self.assertFalse(needs_reconcile)
        self.assertTrue(manager.desired_ducking())

        manager.commands.apply(connection, {"command": "set-duck", "active": False})
        self.assertFalse(manager.desired_ducking())

    def test_a_disconnecting_controller_releases_its_duck_request(self) -> None:
        manager = self._duckable_manager()
        connection = mock.Mock()
        manager.control.clients[connection] = b""

        manager.commands.apply(connection, {"command": "set-duck", "active": True})
        self.assertTrue(manager.desired_ducking())

        # Losing the socket is the liveness signal: a controller that crashes
        # mid-conversation must not leave background audio ducked.
        manager.control.drop(connection)
        self.assertFalse(manager.desired_ducking())

    def test_ducking_stays_off_when_the_background_path_is_disabled(self) -> None:
        manager = self.make_manager({"background": {"enabled": False}})
        manager.commands.apply(mock.Mock(), {"command": "set-duck", "active": True})
        self.assertFalse(manager.desired_ducking())

    def test_set_duck_rejects_a_non_boolean_request(self) -> None:
        manager = self._duckable_manager()
        reply, _ = manager.commands.apply(
            mock.Mock(), {"command": "set-duck", "active": "yes"}
        )
        self.assertEqual(reply["event"], "error")
        self.assertFalse(manager.desired_ducking())

    def test_unknown_commands_are_rejected(self) -> None:
        manager = self._duckable_manager()
        reply, reconcile = manager.commands.apply(mock.Mock(), {"command": "explode"})
        self.assertEqual(reply["event"], "error")
        self.assertFalse(reconcile)

    def _duckable_manager(self) -> AudioManager:
        return self.make_manager({"background": {"enabled": True}})


class VoiceLevelTests(ManagerTestCase):
    def test_block_level_rises_with_amplitude_and_floors_at_silence(self) -> None:
        def block(amplitude: int) -> bytes:
            samples = array.array(
                "h", [amplitude if index % 2 else -amplitude for index in range(160)]
            )
            return samples.tobytes()

        self.assertEqual(levels.block_level(block(0)), 0.0)
        loud = levels.block_level(block(30000))
        quiet = levels.block_level(block(600))
        self.assertGreater(loud, quiet)
        self.assertLessEqual(loud, 1.0)
        self.assertGreaterEqual(quiet, 0.0)
        # Anything under the floor is a pause between words, not quiet speech.
        self.assertEqual(levels.block_level(block(20)), 0.0)

    def test_metering_is_held_against_the_requesting_connection(self) -> None:
        manager = self.make_manager({})
        connection = mock.Mock()
        manager.control.clients[connection] = b""

        manager.commands.apply(
            connection, {"command": "set-voice-meter", "active": True}
        )
        self.assertEqual(manager.commands.meter_listeners, frozenset({connection}))

        # Losing the socket releases the capture, exactly as it releases a duck.
        manager.control.drop(connection)
        self.assertEqual(manager.commands.meter_listeners, frozenset())

    def test_set_voice_meter_rejects_a_non_boolean_request(self) -> None:
        manager = self.make_manager({})
        reply, reconcile = manager.commands.apply(
            mock.Mock(), {"command": "set-voice-meter", "active": "yes"}
        )
        self.assertEqual(reply["event"], "error")
        self.assertFalse(reconcile)
        self.assertEqual(manager.commands.meter_listeners, frozenset())

    def test_levels_reach_only_the_connections_that_asked_for_them(self) -> None:
        manager = self.make_manager({})
        listening, quiet = mock.Mock(), mock.Mock()
        manager.control.clients[listening] = b""
        manager.control.clients[quiet] = b""
        manager.commands.apply(listening, {"command": "set-voice-meter", "active": True})

        with mock.patch.object(manager.control, "send") as send:
            manager._publish_voice_level(0.5)

        self.assertEqual(
            [call.args[0] for call in send.call_args_list], [listening]
        )
        self.assertEqual(send.call_args.args[1]["event"], "voice_level")

    def test_the_capture_starts_only_once_its_monitor_exists(self) -> None:
        clock = 1000.0
        spawned: list[list[str]] = []

        def spawn(command: list[str]) -> Any:
            spawned.append(command)
            read_fd, write_fd = os.pipe()
            self.addCleanup(os.close, write_fd)
            capture = mock.Mock(stdout=open(read_fd, "rb", buffering=0))
            capture.poll.return_value = None
            return capture

        selector = selectors.DefaultSelector()
        self.addCleanup(selector.close)
        meter = levels.VoiceLevelMeter(
            selector, lambda _level: None, spawn=spawn, clock=lambda: clock
        )
        self.addCleanup(meter.close)

        meter.request(True)
        meter.tick()
        self.assertEqual(spawned, [])

        meter.set_source("smartamp_voice.monitor")
        meter.tick()
        self.assertEqual(len(spawned), 1)
        self.assertIn("--device=smartamp_voice.monitor", spawned[0])

        # Releasing holds the capture briefly, so the next reply in the same
        # conversation is not metered from a cold start.
        meter.request(False)
        meter.tick()
        self.assertEqual(meter.deadline(), 1000.0 + levels.LINGER_SECONDS)


class SubscribeEventTests(unittest.TestCase):
    def test_subscribe_lines_filter_out_self_inflicted_noise(self) -> None:
        self.assertTrue(monitors.is_relevant_event("Event 'change' on sink #43"))
        self.assertTrue(monitors.is_relevant_event("Event 'remove' on module #7"))
        # pactl invocations from our own reconcile emit client events; reacting
        # to them would reconcile forever.
        self.assertFalse(monitors.is_relevant_event("Event 'new' on client #99"))
        self.assertFalse(monitors.is_relevant_event("garbage"))


class UsbGadgetTests(unittest.TestCase):
    def test_usb_host_detection_reads_the_udc_state_file(self) -> None:
        with tempfile.TemporaryDirectory() as base:
            root = Path(base)
            self.assertFalse(usb_gadget.host_attached(root))

            udc = root / "1000480000.usb"
            udc.mkdir()
            (udc / "state").write_text("not attached\n", encoding="utf-8")
            self.assertFalse(usb_gadget.host_attached(root))

            (udc / "state").write_text("configured\n", encoding="utf-8")
            self.assertTrue(usb_gadget.host_attached(root))

        self.assertFalse(usb_gadget.host_attached(root / "missing"))

    def test_usb_streaming_detection_reads_the_gadget_rate_control(self) -> None:
        listing = (
            "numid=4,iface=PCM,name='Capture Rate'\n"
            "  ; type=INTEGER,access=r--v----,values=1,min=48000,max=48000,step=0\n"
            "  : values={rate}\n"
        )
        cases = [
            (completed("amixer", stdout=listing.format(rate=48000)), True),
            (completed("amixer", stdout=listing.format(rate=0)), False),
            (completed("amixer", returncode=1), False),
            (completed("amixer", stdout="garbage"), False),
        ]
        for result, expected in cases:
            with mock.patch.object(process, "run", return_value=result):
                self.assertEqual(usb_gadget.streaming(), expected)


class ReconcileTests(ManagerTestCase):
    def test_failed_module_unload_remains_tracked_for_retry(self) -> None:
        manager = self.make_manager({})
        manager.modules.adopt("aux", 60)

        with mock.patch.object(
            pactl,
            "unload_module",
            side_effect=subprocess.CalledProcessError(1, ("pactl",)),
        ), self.assertRaises(subprocess.CalledProcessError):
            manager.modules.unload("aux")

        self.assertIn("aux", manager.modules)

    def test_failed_reconcile_retries_after_one_second(self) -> None:
        manager = self.make_manager({"resync_seconds": 900})
        manager.pending_reconcile = 50.0

        with mock.patch.object(
            manager, "reconcile", side_effect=RuntimeError("graph moved")
        ), mock.patch(
            "audio_manager.daemon.time.monotonic", return_value=100.0
        ), self.assertLogs(
            "audio_manager.daemon", level="WARNING"
        ):
            succeeded = manager.safe_reconcile()

        self.assertFalse(succeeded)
        self.assertIsNone(manager.pending_reconcile)
        self.assertEqual(manager.next_resync, 101.0)

    def test_usb_route_bridges_only_while_the_host_is_streaming(self) -> None:
        manager = self.make_manager(
            {
                "sources": {
                    "usb": {
                        "match": "UAC2Gadget",
                        "requires_usb_host": True,
                        "latency_ms": 20,
                    }
                }
            }
        )
        manager.routes.enabled = {"usb": True}
        loaded: list[str] = []
        capture_node = {
            "name": "uac2_capture",
            "description": "UAC2Gadget",
            "monitor_of_sink": 4294967295,
        }
        listings = {
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [],
            "sink-inputs": [],
            "cards": [
                {
                    "name": "alsa_card.platform-1000480000.usb",
                    "properties": {"alsa.id": "UAC2Gadget"},
                    "profiles": {"off": {}, "pro-audio": {}},
                    "active_profile": "off",
                }
            ],
        }
        commands: list[tuple[str, ...]] = []

        def load_module(module: str, *arguments: str) -> int:
            loaded.append(module)
            return 50

        def run(*args: str, check: bool = True) -> Any:
            commands.append(args)
            return fake_run(*args, check=check)

        def reconcile(attached: bool, streaming: bool) -> dict[str, Any]:
            with self._patched_graph(listings, run), mock.patch.object(
                pactl, "load_module", side_effect=load_module
            ), mock.patch.object(
                usb_gadget, "host_attached", return_value=attached
            ), mock.patch.object(
                usb_gadget, "streaming", return_value=streaming
            ), mock.patch(
                "audio_manager.status.write"
            ) as status_write:
                manager.reconcile()
            return status_write.call_args.args[1]

        # The gadget card boots parked in its "off" profile (it has no mixer,
        # so WirePlumber never activates a profile itself) and offers no
        # capture node until the manager switches it on.
        status = reconcile(attached=True, streaming=True)
        self.assertIn(
            (
                "pactl",
                "set-card-profile",
                "alsa_card.platform-1000480000.usb",
                "pro-audio",
            ),
            commands,
        )
        self.assertEqual(loaded, [])
        self.assertFalse(status["sources"]["usb"]["available"])
        listings["sources"] = [capture_node]
        listings["cards"][0]["active_profile"] = "pro-audio"

        # Enabled and enumerated but not streaming — the computer is playing
        # to another output, or the cable is gone and the VBUS-blocked port
        # never noticed. Either way the capture clock is dead and bridging it
        # would stall the whole output graph, so no bridge.
        status = reconcile(attached=True, streaming=False)
        self.assertEqual(loaded, [])
        self.assertTrue(status["usb_host"])
        self.assertFalse(status["usb_playback"])
        self.assertFalse(status["sources"]["usb"]["available"])
        self.assertTrue(status["sources"]["usb"]["enabled"])

        status = reconcile(attached=True, streaming=True)
        self.assertEqual(loaded, ["module-loopback"])
        self.assertTrue(status["usb_playback"])
        self.assertTrue(status["sources"]["usb"]["available"])

        status = reconcile(attached=True, streaming=False)
        self.assertNotIn("usb", manager.modules)
        self.assertFalse(status["sources"]["usb"]["available"])

    def test_usb_volume_sync_follows_whichever_side_moved(self) -> None:
        manager = self.make_manager({})
        manager.music_volume = 40
        gadget = {"volume": 30, "muted": False}
        sinks = [
            {
                "name": "hifiberry",
                "description": "HiFiBerry DAC2 ADC Pro",
                "mute": False,
                "volume": {
                    "front-left": {"value_percent": "100%"},
                    "front-right": {"value_percent": "100%"},
                },
            }
        ]
        listings = {"sinks": sinks, "sources": [], "sink-inputs": [], "cards": []}
        commands: list[tuple[str, ...]] = []

        def run(*args: str, check: bool = True) -> Any:
            commands.append(args)
            if args[0] == "amixer" and "sget" in args:
                state = f"[{gadget['volume']}%] [{'off' if gadget['muted'] else 'on'}]"
                return completed(*args, stdout=f"  Mono: Capture 123 {state}\n")
            if args[0] == "amixer" and "sset" in args:
                gadget["volume"] = int(args[6].rstrip("%"))
                gadget["muted"] = args[7] == "nocap"
                return completed(*args)
            if args[:2] == ("pactl", "set-sink-mute"):
                sinks[0]["mute"] = args[3] == "1"
                return completed(*args)
            return fake_run(*args, check=check)

        def reconcile() -> None:
            with self._patched_graph(listings, run), mock.patch.object(
                usb_gadget, "card_present", return_value=True
            ), mock.patch.object(
                usb_gadget, "host_attached", return_value=True
            ), mock.patch(
                "audio_manager.status.write"
            ):
                manager.reconcile()

        # First sight: the amp's music level seeds the gadget, so a computer
        # plugging in reads the real level rather than a stale one.
        reconcile()
        self.assertEqual(gadget, {"volume": 40, "muted": False})

        # The computer moves its slider and mutes: the music level and the
        # sink mute follow; the sink volume itself stays pinned.
        gadget.update(volume=55, muted=True)
        reconcile()
        self.assertEqual(manager.music_volume, 55)
        self.assertIn(("pactl", "set-sink-mute", "hifiberry", "1"), commands)
        self.assertNotIn(("pactl", "set-sink-volume", "hifiberry", "55%"), commands)

        # A settled graph stays quiet: no further writes on the next pass.
        writes = len(commands)
        reconcile()
        self.assertEqual(
            [c for c in commands[writes:] if "sset" in c or "set-sink-mute" in c],
            [],
        )

        # The amp dial moves the music level and unmutes: the gadget follows,
        # so the computer's slider tracks the amp.
        manager.music_volume = 70
        sinks[0]["mute"] = False
        reconcile()
        self.assertEqual(gadget, {"volume": 70, "muted": False})

    def test_commanded_music_volume_survives_a_stale_gadget_reading(self) -> None:
        manager = self.make_manager({})
        manager.music_volume = 80
        gadget = {"volume": 80, "muted": False}
        sinks = [
            {
                "name": "hifiberry",
                "description": "HiFiBerry DAC2 ADC Pro",
                "mute": False,
                "volume": {
                    "front-left": {"value_percent": "100%"},
                    "front-right": {"value_percent": "100%"},
                },
            }
        ]
        listings = {"sinks": sinks, "sources": [], "sink-inputs": [], "cards": []}

        def run(*args: str, check: bool = True) -> Any:
            if args[0] == "amixer" and "sget" in args:
                state = f"[{gadget['volume']}%] [{'off' if gadget['muted'] else 'on'}]"
                return completed(*args, stdout=f"  Mono: Capture 123 {state}\n")
            if args[0] == "amixer" and "sset" in args:
                gadget["volume"] = int(args[6].rstrip("%"))
                gadget["muted"] = args[7] == "nocap"
                return completed(*args)
            return fake_run(*args, check=check)

        def patched(action: Any) -> None:
            with self._patched_graph(listings, run), mock.patch.object(
                usb_gadget, "card_present", return_value=True
            ), mock.patch.object(
                usb_gadget, "host_attached", return_value=True
            ), mock.patch(
                "audio_manager.status.write"
            ):
                action()

        # Both sides agree at 80.
        patched(manager.reconcile)
        self.assertEqual(gadget["volume"], 80)

        # A dial step commands 60 while the host has re-quantised the gadget to
        # 75. The command must forget the old agreement so the next reconcile
        # seeds the gadget with 60 rather than clawing the level back to 75.
        patched(
            lambda: manager.commands.apply(
                mock.Mock(), {"command": "set-music-volume", "percent": 60}
            )
        )
        gadget["volume"] = 75
        patched(manager.reconcile)
        self.assertEqual(manager.music_volume, 60)
        self.assertEqual(gadget, {"volume": 60, "muted": False})

    def test_muted_route_keeps_its_bridge_and_toggles_by_fading(self) -> None:
        manager = self.make_manager(
            {
                "sources": {
                    "aux": {"match": "ADC Pro", "mute_when_off": True, "latency_ms": 20}
                }
            }
        )
        manager.routes.enabled = {"aux": False}
        loaded: list[str] = []
        listings = {
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [
                {
                    "name": "hifiberry_adc",
                    "description": "HiFiBerry DAC2 ADC Pro",
                    "monitor_of_sink": 4294967295,
                }
            ],
            "sink-inputs": [{"index": 61, "owner_module": 60}],
            "cards": [],
            "modules": [],
        }

        def load_module(module: str, *arguments: str) -> int:
            listings["modules"].append(
                {"index": 60, "name": module, "argument": " ".join(arguments)}
            )
            loaded.append(module)
            return 60

        def run(*args: str, check: bool = True) -> Any:
            if "set-sink-input-volume" in args:
                listings["sink-inputs"][0]["volume"] = {
                    "mono": {"value_percent": args[-1]}
                }
            return fake_run(*args, check=check)

        def reconcile() -> list[str]:
            with self._patched_graph(listings, run) as run_mock, mock.patch.object(
                pactl, "load_module", side_effect=load_module
            ), mock.patch("audio_manager.volume.time.sleep"), mock.patch(
                "audio_manager.status.write"
            ):
                manager.reconcile()
            return [
                call.args[-1]
                for call in run_mock.call_args_list
                if "set-sink-input-volume" in call.args
            ]

        # Off at boot: the bridge still loads, snapped straight to silent so
        # the pop-prone stream connect happens once, before anything plays.
        self.assertEqual(reconcile(), ["0%"])
        self.assertEqual(loaded, ["module-loopback"])

        # Turning the route on is a fade, not a module load.
        manager.routes.enabled["aux"] = True
        volumes = reconcile()
        self.assertEqual(loaded, ["module-loopback"])
        self.assertGreater(len(volumes), 1)
        self.assertEqual(volumes[-1], "100%")

        manager.routes.enabled["aux"] = False
        volumes = reconcile()
        self.assertEqual(volumes[-1], "0%")

        # A settled toggle fades nothing on the next reconcile.
        self.assertEqual(reconcile(), [])

        # Live drift is repaired even when the desired toggle did not change.
        listings["sink-inputs"][0]["volume"] = {
            "mono": {"value_percent": "25%"}
        }
        self.assertEqual(reconcile(), ["0%"])

        # PipeWire can recreate the stream without recreating its module. The
        # replacement must be recognised and snapped silent too.
        listings["sink-inputs"][0].update(
            index=62, volume={"mono": {"value_percent": "100%"}}
        )
        self.assertEqual(reconcile(), ["0%"])
        self.assertEqual(manager.routes.stream_indices["aux"], 62)

    def test_aec_reference_bridges_output_monitor_into_the_xvf3800(self) -> None:
        manager = self.make_manager(
            {
                "aec_reference": {
                    "enabled": True,
                    "sink_match": "XVF3800",
                    "latency_ms": 40,
                }
            }
        )
        loaded: list[tuple[str, tuple[str, ...]]] = []
        listings = {
            "sinks": [
                {"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"},
                {
                    "name": "xvf_playback",
                    "description": "reSpeaker XVF3800",
                    # WirePlumber restored a quiet, muted state that would make
                    # the DSP under-subtract; reconcile must repair it.
                    "volume": {"mono": {"value_percent": "40%"}},
                    "mute": True,
                },
            ],
            "sources": [
                {"name": "hifiberry.monitor", "monitor_of_sink": 0},
                {
                    "name": "xvf_mic",
                    "description": "reSpeaker XVF3800 Mic Array",
                    "monitor_of_sink": 4294967295,
                },
            ],
            "sink-inputs": [
                # A reference stream left behind at a stale level, as after a
                # PipeWire restart recreated it.
                {
                    "index": 55,
                    "properties": {"media.name": "SmartAmp.aec"},
                    "volume": {"mono": {"value_percent": "40%"}},
                }
            ],
            "cards": [],
        }

        with self._patched_graph(listings, fake_run) as run, mock.patch.object(
            pactl, "load_module", side_effect=self._recording_loader(loaded)
        ), mock.patch("audio_manager.status.write") as status_write:
            manager.reconcile()

        # The far-end reference is what the room hears: the output sink's
        # monitor looped into the XVF3800 playback endpoint.
        self.assertEqual(
            loaded,
            [
                (
                    "module-loopback",
                    (
                        "source=hifiberry.monitor",
                        "sink=xvf_playback",
                        "latency_msec=40",
                        "source_dont_move=true",
                        "sink_dont_move=true",
                        "sink_input_properties=media.name=SmartAmp.aec",
                    ),
                )
            ],
        )
        status = status_write.call_args.args[1]
        self.assertEqual(
            status["aec_reference"],
            {"enabled": True, "available": True, "sink": "xvf_playback"},
        )

        # The reference must reach the DSP at the level the room hears: the
        # sink and the bridge stream are snapped back to unity, unmuted.
        commands = [call.args for call in run.call_args_list]
        self.assertIn(("pactl", "set-sink-volume", "xvf_playback", "100%"), commands)
        self.assertIn(("pactl", "set-sink-mute", "xvf_playback", "0"), commands)
        self.assertIn(("pactl", "set-sink-input-volume", "55", "100%"), commands)

    def test_aec_reference_is_released_when_the_xvf3800_disappears(self) -> None:
        manager = self.make_manager(
            {
                "aec_reference": {
                    "enabled": True,
                    "sink_match": "XVF3800",
                    "latency_ms": 40,
                }
            }
        )
        manager.modules.adopt("_aec", 30, ("hifiberry.monitor", "xvf_playback"))
        listings = {
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [{"name": "hifiberry.monitor", "monitor_of_sink": 0}],
            "sink-inputs": [],
            "cards": [],
            "modules": [{"index": 30}],
        }

        with self._patched_graph(listings, fake_run) as run, mock.patch(
            "audio_manager.status.write"
        ) as status_write:
            manager.reconcile()

        self.assertNotIn("_aec", manager.modules)
        self.assertIn(
            ("pactl", "unload-module", "30"), [call.args for call in run.call_args_list]
        )
        status = status_write.call_args.args[1]
        self.assertEqual(
            status["aec_reference"],
            {"enabled": True, "available": False, "sink": None},
        )

    def test_voice_capture_publishes_the_asr_channel_as_the_default_source(
        self,
    ) -> None:
        manager = self.make_manager({"voice_capture_channel": 1})
        loaded: list[tuple[str, tuple[str, ...]]] = []
        listings = {
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [
                # Listed first, and naming its master in a property, to prove
                # the remap source can never be matched as the voice device.
                {
                    "name": "smartamp_voice_capture",
                    "monitor_of_sink": 4294967295,
                    "properties": {"device.master_device": "alsa_input.usb-XVF3800"},
                },
                {
                    "name": "xvf_mic",
                    "description": "reSpeaker XVF3800 Mic Array",
                    "monitor_of_sink": 4294967295,
                    "channel_map": "front-left,front-right",
                },
            ],
            "sink-inputs": [],
            "cards": [],
        }

        with self._patched_graph(listings, fake_run) as run, mock.patch.object(
            pactl, "load_module", side_effect=self._recording_loader(loaded)
        ), mock.patch("audio_manager.status.write") as status_write:
            manager.reconcile()

        # Channel 1 is the XVF3800's ASR output; front-right is its label in
        # the device channel map. remix=no keeps the Conference channel out.
        self.assertEqual(
            loaded,
            [
                (
                    "module-remap-source",
                    (
                        "source_name=smartamp_voice_capture",
                        "master=xvf_mic",
                        "channels=1",
                        "channel_map=mono",
                        "master_channel_map=front-right",
                        "remix=no",
                        "source_properties=device.description=SmartAmp_Voice_Capture",
                    ),
                )
            ],
        )
        self.assertIn(
            ("pactl", "set-default-source", "smartamp_voice_capture"),
            [call.args for call in run.call_args_list],
        )
        status = status_write.call_args.args[1]
        self.assertEqual(status["voice_input"], "xvf_mic")
        self.assertEqual(
            status["voice_capture"], {"channel": 1, "source": "smartamp_voice_capture"}
        )

    def test_voice_capture_falls_back_to_the_device_without_that_channel(self) -> None:
        manager = self.make_manager({"voice_capture_channel": 1})
        listings = {
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [
                {
                    "name": "mono_mic",
                    "description": "reSpeaker XVF3800 Mic Array",
                    "monitor_of_sink": 4294967295,
                    "channel_map": "mono",
                }
            ],
            "sink-inputs": [],
            "cards": [],
        }

        with self._patched_graph(listings, fake_run) as run, mock.patch.object(
            pactl, "load_module"
        ) as load_module, mock.patch("audio_manager.status.write") as status_write:
            manager.reconcile()

        load_module.assert_not_called()
        self.assertIn(
            ("pactl", "set-default-source", "mono_mic"),
            [call.args for call in run.call_args_list],
        )
        status = status_write.call_args.args[1]
        self.assertEqual(status["voice_capture"], {"channel": 1, "source": None})

    def test_voice_capture_is_released_when_the_xvf3800_disappears(self) -> None:
        manager = self.make_manager({"voice_capture_channel": 1})
        manager.modules.adopt("_voice_capture", 40, ("xvf_mic", "front-right"))
        listings = {
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [{"name": "hifiberry.monitor", "monitor_of_sink": 0}],
            "sink-inputs": [],
            "cards": [],
            "modules": [{"index": 40}],
        }

        with self._patched_graph(listings, fake_run) as run, mock.patch(
            "audio_manager.status.write"
        ):
            manager.reconcile()

        self.assertNotIn("_voice_capture", manager.modules)
        self.assertIn(
            ("pactl", "unload-module", "40"), [call.args for call in run.call_args_list]
        )

    @staticmethod
    def _recording_loader(loaded: list[tuple[str, tuple[str, ...]]]) -> Any:
        def load_module(module: str, *arguments: str) -> int:
            loaded.append((module, arguments))
            return 30 + len(loaded)

        return load_module


class IdleTeardownTests(ManagerTestCase):
    def test_a_quiet_graph_releases_its_bridges_and_playback_rebuilds_them(
        self,
    ) -> None:
        manager = self.make_manager(
            {
                "idle_teardown_seconds": 60,
                "aec_reference": {
                    "enabled": True,
                    "sink_match": "XVF3800",
                    "latency_ms": 40,
                },
                "background": {
                    "enabled": True,
                    "sink_name": "background",
                    "latency_ms": 40,
                },
                "sources": {
                    "aux": {"match": "ADC Pro", "mute_when_off": True, "latency_ms": 20}
                },
            }
        )
        clock = {"now": 0.0}
        manager.idle = IdleTracker(60, clock=lambda: clock["now"])
        playing = {
            "index": 500,
            "properties": {"media.name": "ALSA Playback"},
            "volume": {"mono": {"value_percent": "100%"}},
        }
        listings: dict[str, Any] = {
            "sinks": [
                {"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"},
                {
                    "name": "xvf_playback",
                    "description": "reSpeaker XVF3800",
                    "volume": {"mono": {"value_percent": "100%"}},
                    "mute": False,
                },
            ],
            "sources": [
                {"name": "hifiberry.monitor", "monitor_of_sink": 0},
                {
                    "name": "hifiberry_adc",
                    "description": "HiFiBerry DAC2 ADC Pro",
                    "monitor_of_sink": 4294967295,
                },
            ],
            "sink-inputs": [playing],
            "cards": [],
            "modules": [],
        }
        next_id = {"value": 9}

        def load_module(module: str, *arguments: str) -> int:
            next_id["value"] += 1
            module_id = next_id["value"]
            listings["modules"].append(
                {"index": module_id, "name": module, "argument": " ".join(arguments)}
            )
            if module == "module-null-sink":
                listings["sinks"].append(
                    {"name": "background", "owner_module": module_id}
                )
                listings["sources"].append({"name": "background.monitor"})
            else:
                media = next(
                    argument.split("media.name=")[1]
                    for argument in arguments
                    if "media.name=" in argument
                )
                listings["sink-inputs"].append(
                    {
                        "index": 100 + module_id,
                        "owner_module": module_id,
                        "properties": {"media.name": media},
                        "volume": {"mono": {"value_percent": "100%"}},
                    }
                )
            return module_id

        commands: list[tuple[str, ...]] = []

        def run(*args: str, check: bool = True) -> Any:
            commands.append(args)
            if args[:2] == ("pactl", "unload-module"):
                module_id = int(args[2])
                listings["modules"] = [
                    module
                    for module in listings["modules"]
                    if module["index"] != module_id
                ]
                listings["sink-inputs"] = [
                    stream
                    for stream in listings["sink-inputs"]
                    if stream.get("owner_module") != module_id
                ]
                return completed(*args)
            if args[:2] == ("pactl", "set-sink-input-volume"):
                for stream in listings["sink-inputs"]:
                    if str(stream.get("index")) == args[2]:
                        stream["volume"] = {"mono": {"value_percent": args[3]}}
                return completed(*args)
            return fake_run(*args, check=check)

        def reconcile() -> dict[str, Any]:
            with self._patched_graph(listings, run), mock.patch.object(
                pactl, "load_module", side_effect=load_module
            ), mock.patch.object(
                usb_gadget, "host_attached", return_value=False
            ), mock.patch(
                "audio_manager.volume.time.sleep"
            ), mock.patch(
                "audio_manager.status.write"
            ) as status_write:
                manager.reconcile()
            return status_write.call_args.args[1]

        # Something is playing: the sink, its bridge, the AEC reference, and
        # the muted aux bridge all come up.
        status = reconcile()
        self.assertFalse(status["idle"])
        for role in ("_background_sink", "_background_bridge", "_aec", "aux"):
            self.assertIn(role, manager.modules)

        # The stream ends. Inside the timeout everything stays loaded — the
        # daemon's own bridge streams must not count as activity.
        listings["sink-inputs"] = [
            stream for stream in listings["sink-inputs"] if stream is not playing
        ]
        clock["now"] = 30.0
        status = reconcile()
        self.assertFalse(status["idle"])
        self.assertIn("_background_bridge", manager.modules)

        # Past the timeout the bridges are released; the null sink stays so
        # clients pointed at it by PULSE_SINK keep their target. Nothing is
        # playing, so the teardown needs no protective mute.
        clock["now"] = 90.0
        status = reconcile()
        self.assertTrue(status["idle"])
        for role in ("_background_bridge", "_aec", "aux"):
            self.assertNotIn(role, manager.modules)
        self.assertIn("_background_sink", manager.modules)
        self.assertIsNone(manager.idle.deadline())
        self.assertNotIn("set-sink-mute", {arg for args in commands for arg in args})

        # A client starts playing again: everything rebuilds on the next pass,
        # behind a mute held on the output sink, because the fresh bridge
        # streams run at full volume until their gains land.
        listings["sink-inputs"].append(playing)
        clock["now"] = 100.0
        before_rebuild = len(commands)
        status = reconcile()
        self.assertFalse(status["idle"])
        for role in ("_background_bridge", "_aec", "aux"):
            self.assertIn(role, manager.modules)
        rebuild = commands[before_rebuild:]
        muted = rebuild.index(("pactl", "set-sink-mute", "hifiberry", "1"))
        unmuted = rebuild.index(("pactl", "set-sink-mute", "hifiberry", "0"))
        self.assertLess(muted, unmuted)
        self.assertEqual(unmuted, len(rebuild) - 1)

    def test_a_voice_session_wakes_an_idle_graph_immediately(self) -> None:
        manager = self.make_manager(
            {"idle_teardown_seconds": 60, "background": {"enabled": True}}
        )
        manager.idle.idle = True
        self.assertIsNone(manager.pending_reconcile)

        # The duck request arrives seconds before the first TTS stream exists,
        # so it must start the rebuild rather than wait for audio to appear.
        manager.commands.apply(mock.Mock(), {"command": "set-duck", "active": True})
        self.assertIsNotNone(manager.pending_reconcile)

    def test_teardown_stays_off_by_default(self) -> None:
        manager = self.make_manager({})
        self.assertFalse(manager.idle.enabled)
        self.assertFalse(manager.idle.update(False))
        self.assertIsNone(manager.idle.deadline())


class VolumeTests(ManagerTestCase):
    def test_output_sink_is_pinned_to_full_scale(self) -> None:
        with mock.patch.object(process, "run") as run:
            output.pin_volume(None)
            run.assert_not_called()

            # WirePlumber restored an old dial level: pin it back to 100.
            output.pin_volume(
                {"name": "hifi", "volume": {"mono": {"value_percent": "20%"}}}
            )
            run.assert_called_once_with("pactl", "set-sink-volume", "hifi", "100%")

            # An already pinned sink writes nothing, so the pin can never echo
            # itself into another reconcile.
            output.pin_volume(
                {"name": "hifi", "volume": {"mono": {"value_percent": "100%"}}}
            )
            run.assert_called_once()

    def test_output_mute_is_commanded_and_read_back_from_the_sink(self) -> None:
        manager = self.make_manager({"sources": {}})
        sink = {"name": "hifi", "volume": {"mono": {"value_percent": "100%"}}}

        with mock.patch.object(process, "run") as run, mock.patch.object(
            manager.graph, "find_sink", return_value=sink
        ):
            reply, _ = manager.commands.apply(
                mock.Mock(), {"command": "set-output-mute", "muted": True}
            )
            self.assertTrue(reply["output_muted"])
            run.assert_called_once_with("pactl", "set-sink-mute", "hifi", "1")

        # A mute made elsewhere arrives on the next pass rather than by polling.
        self.assertIs(output.mute_state({**sink, "mute": True}), True)
        self.assertIs(output.mute_state({**sink, "mute": False}), False)
        # A sink that reports no volume leaves the last known answer alone.
        self.assertIsNone(output.mute_state({"name": "hifi"}))

        reply, _ = manager.commands.apply(
            mock.Mock(), {"command": "set-output-mute", "muted": "yes"}
        )
        self.assertEqual(reply["event"], "error")

    def test_startup_config_seeds_the_music_and_voice_levels(self) -> None:
        with tempfile.TemporaryDirectory() as base:
            config = Path(base) / "audio.json"
            config.write_text(
                json.dumps(
                    {
                        "startup_volume_percent": 20,
                        "voice_bus": {"enabled": True, "volume_percent": 50},
                        "sources": {},
                    }
                ),
                encoding="utf-8",
            )
            manager = AudioManager(
                AudioConfig.load(config),
                Path(base) / "control.sock",
                Path(base) / "status.json",
            )
            self.addCleanup(manager.selector.close)
        self.assertEqual(manager.music_volume, 20)
        self.assertEqual(manager.voice_volume, 50)

    def test_background_bridge_fades_without_changing_client_volumes(self) -> None:
        manager = self.make_manager(
            {"background": {"enabled": True, "duck_volume_percent": 15, "fade_ms": 100}}
        )
        manager.background.stream_index = 42
        manager.background.ducked = False
        manager.background.gain_applied = 100

        with mock.patch.object(process, "run") as run, mock.patch(
            "audio_manager.volume.time.sleep"
        ):
            manager.background.apply_ducking(manager.music_volume, True)

        self.assertEqual([call.args[-1] for call in run.call_args_list], ["58%", "15%"])
        self.assertTrue(manager.background.ducked)

    def test_ducked_music_dips_by_the_duck_share_of_the_music_level(self) -> None:
        manager = self.make_manager(
            {"background": {"enabled": True, "duck_volume_percent": 15}}
        )
        manager.music_volume = 60
        self.assertEqual(manager.background.target_gain(60, False), 60)
        self.assertEqual(manager.background.target_gain(60, True), 9)

    def test_voice_volume_command_applies_the_bridge_gain(self) -> None:
        manager = self.make_manager({"voice_bus": {"enabled": True}})
        manager.voice_bus.stream_index = 33

        with mock.patch.object(process, "run") as run:
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-voice-volume", "percent": 40}
            )

        self.assertEqual(reply["voice_volume"], 40)
        # One stream volume, like ducking: never a full graph reconcile.
        self.assertFalse(reconcile)
        # The sink is pinned, so the bridge gain is the voice level itself,
        # whatever the music is doing.
        run.assert_called_once_with("pactl", "set-sink-input-volume", "33", "40%")

    def test_failed_voice_gain_is_not_cached_and_schedules_a_retry(self) -> None:
        manager = self.make_manager({"voice_bus": {"enabled": True}})
        manager.voice_bus.stream_index = 33

        with mock.patch.object(
            process,
            "run",
            side_effect=subprocess.CalledProcessError(1, ("pactl",)),
        ), self.assertLogs("audio_manager.daemon", level="WARNING"):
            manager.set_voice_volume(40)

        self.assertIsNone(manager.voice_bus.gain_applied)
        self.assertIsNotNone(manager.pending_reconcile)

        with mock.patch.object(process, "run") as run:
            manager.voice_bus.apply_gain(40)

        run.assert_called_once()
        self.assertEqual(manager.voice_bus.gain_applied, 40)

    def test_voice_volume_rejects_anything_but_a_percent(self) -> None:
        manager = self.make_manager({"voice_bus": {"enabled": True}})
        for percent in ("50", True, -1, 101, None):
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-voice-volume", "percent": percent}
            )
            self.assertEqual(reply["event"], "error")
            self.assertFalse(reconcile)
        self.assertEqual(manager.voice_volume, 100)

    def test_music_volume_command_moves_the_bus_and_direct_routes(self) -> None:
        manager = self.make_manager(
            {
                "background": {
                    "enabled": True,
                    "duck_volume_percent": 15,
                    "fade_ms": 0,
                },
                "sources": {
                    "aux": {"match": "ADC Pro", "mute_when_off": True, "latency_ms": 20}
                },
            }
        )
        manager.modules.adopt("aux", 60)
        manager.routes.enabled["aux"] = True
        manager.routes.unmuted = {"aux": True}
        manager.routes.stream_indices = {"aux": 61}
        manager.background.stream_index = 42
        manager.background.ducked = False
        manager.background.gain_applied = 100
        sink_inputs = [
            {
                "index": 61,
                "owner_module": 60,
                "volume": {"mono": {"value_percent": "100%"}},
            }
        ]

        with mock.patch.object(
            pactl, "list_json", return_value=sink_inputs
        ), mock.patch.object(process, "run") as run, mock.patch(
            "audio_manager.volume.time.sleep"
        ):
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-music-volume", "percent": 30}
            )

        self.assertEqual(reply["music_volume"], 30)
        self.assertFalse(reconcile)
        # The background bus snaps to the new level and the unmuted aux bridge
        # follows it; the voice bridge is left alone.
        self.assertEqual(volume_writes(run), [("42", "30%"), ("61", "30%")])

    def test_each_music_input_carries_its_own_trim(self) -> None:
        manager = self.make_manager(
            {
                "background": {
                    "enabled": True,
                    "sink_name": "background",
                    "client_volume_percent": 70,
                },
                "sources": {
                    "aux": {
                        "match": "ADC Pro",
                        "mute_when_off": True,
                        "volume_percent": 50,
                    },
                    "usb": {
                        "match": "UAC2Gadget",
                        "target": "background",
                        "volume_percent": 80,
                    },
                },
            }
        )
        manager.routes.enabled = {"aux": True, "usb": True}
        manager.routes.unmuted = {"aux": True}
        manager.routes.stream_indices = {"aux": 61}
        manager.modules.adopt("aux", 60)
        manager.modules.adopt("usb", 50)
        output_sink = {"name": "hifiberry", "index": 1}
        background_sink = {"name": "background", "index": 2}
        full = {"mono": {"value_percent": "100%"}}
        listings = {
            "sinks": [output_sink, background_sink],
            "sources": [
                {
                    "name": "hifiberry_adc",
                    "description": "ADC Pro",
                    "monitor_of_sink": 4294967295,
                },
                {
                    "name": "uac2_capture",
                    "description": "UAC2Gadget",
                    "monitor_of_sink": 4294967295,
                },
            ],
            "sink-inputs": [
                {"index": 61, "owner_module": 60, "sink": 1, "volume": full},
                {
                    "index": 71,
                    "owner_module": 50,
                    "sink": 2,
                    "properties": {"media.name": "SmartAmp.usb"},
                    "volume": full,
                },
                # Sendspin's own client stream into the bus.
                {
                    "index": 81,
                    "sink": 2,
                    "properties": {"media.name": "ALSA Playback"},
                    "volume": full,
                },
            ],
        }

        with self._patched_graph(listings, fake_run) as run:
            manager.routes.reconcile(
                output=output_sink,
                background_sink=background_sink,
                music_volume=60,
                usb_playback=True,
            )
            output.hold_client_streams(
                manager.graph,
                background_sink,
                manager.config.background.client_volume_percent,
            )

        # The unmuted aux route plays at half the music level; the USB and
        # Sendspin streams carry only their trims, because their shared bus
        # bridge already carries the music level.
        self.assertEqual(
            volume_writes(run), [("61", "30%"), ("71", "80%"), ("81", "70%")]
        )

    def test_percent_validation_rejects_booleans_and_out_of_range(self) -> None:
        self.assertTrue(volume.is_percent(0))
        self.assertTrue(volume.is_percent(100))
        self.assertFalse(volume.is_percent(True))
        self.assertFalse(volume.is_percent("50"))
        self.assertFalse(volume.is_percent(101))


class BusTests(ManagerTestCase):
    def test_voice_bus_is_bridged_and_a_new_stream_is_snapped_to_the_gain(self) -> None:
        manager = self.make_manager(
            {
                "voice_bus": {
                    "enabled": True,
                    "sink_name": "smartamp_voice",
                    "latency_ms": 40,
                    "volume_percent": 40,
                }
            }
        )
        output_sink = {
            "name": "hifiberry",
            "mute": False,
            "volume": {"mono": {"value_percent": "80%"}},
        }
        voice = {"name": "smartamp_voice", "owner_module": 12}
        listings = {
            "sinks": [output_sink, voice],
            "sources": [{"name": "smartamp_voice.monitor"}],
            "sink-inputs": [
                {
                    "index": 27,
                    "owner_module": 13,
                    "volume": {"mono": {"value_percent": "100%"}},
                }
            ],
            "cards": [],
        }
        loaded: list[tuple[str, tuple[str, ...]]] = []

        def load_module(module: str, *arguments: str) -> int:
            loaded.append((module, arguments))
            return 13

        with mock.patch.object(
            pactl, "list_json", side_effect=lambda kind: listings.get(kind, [])
        ), mock.patch.object(pactl, "list_modules", return_value=[]), mock.patch.object(
            pactl, "load_module", side_effect=load_module
        ), mock.patch.object(process, "run") as run:
            selected = manager.voice_bus.reconcile(output_sink)
            manager.voice_bus.apply_gain(manager.voice_volume)

        self.assertEqual(selected, voice)
        self.assertEqual(manager.voice_bus.stream_index, 27)
        # The existing sink is adopted by its owner module, so only the bridge
        # is loaded.
        self.assertEqual(loaded[0][0], "module-loopback")
        self.assertIn(
            "sink_input_properties=media.name=SmartAmp.voice_bridge", loaded[0][1]
        )
        run.assert_called_once_with("pactl", "set-sink-input-volume", "27", "40%")
        listings["sink-inputs"][0]["volume"] = {
            "mono": {"value_percent": "40%"}
        }

        # A settled bus writes nothing on the next pass.
        with mock.patch.object(
            pactl, "list_json", side_effect=lambda kind: listings.get(kind, [])
        ), mock.patch.object(pactl, "list_modules", return_value=[]), mock.patch.object(
            process, "run"
        ) as run:
            manager.voice_bus.reconcile(output_sink)
            manager.voice_bus.apply_gain(manager.voice_volume)
        run.assert_not_called()

        # A live change on the same stream is reconciled back to the owned gain.
        listings["sink-inputs"][0]["volume"] = {
            "mono": {"value_percent": "75%"}
        }
        with mock.patch.object(
            pactl, "list_json", side_effect=lambda kind: listings.get(kind, [])
        ), mock.patch.object(pactl, "list_modules", return_value=[]), mock.patch.object(
            process, "run"
        ) as run:
            manager.voice_bus.reconcile(output_sink)
            manager.voice_bus.apply_gain(manager.voice_volume)
        run.assert_called_once_with(
            "pactl", "set-sink-input-volume", "27", "40%"
        )

    def test_background_sink_is_created_and_its_bridge_is_identifiable(self) -> None:
        manager = self.make_manager(
            {
                "background": {
                    "enabled": True,
                    "sink_name": "background",
                    "latency_ms": 40,
                }
            }
        )
        output_sink = {"name": "hifiberry"}
        background = {"name": "background", "owner_module": 10}
        listings = {
            "sinks": [output_sink],
            "sources": [],
            "sink-inputs": [{"index": 21, "owner_module": 11}],
            "cards": [],
        }
        loaded: list[tuple[str, tuple[str, ...]]] = []

        def load_module(module: str, *arguments: str) -> int:
            loaded.append((module, arguments))
            if module == "module-null-sink":
                # The sink and its monitor appear once the module is loaded.
                listings["sinks"] = [output_sink, background]
                listings["sources"] = [{"name": "background.monitor"}]
                return 10
            return 11

        with mock.patch.object(
            pactl, "list_json", side_effect=lambda kind: listings.get(kind, [])
        ), mock.patch.object(pactl, "list_modules", return_value=[]), mock.patch.object(
            pactl, "load_module", side_effect=load_module
        ), mock.patch.object(process, "run"):
            selected = manager.background.reconcile(output_sink)

        self.assertEqual(selected, background)
        self.assertEqual(manager.background.stream_index, 21)
        self.assertEqual(loaded[0][0], "module-null-sink")
        self.assertIn("priority.session=1", loaded[0][1][-1])
        self.assertEqual(loaded[1][0], "module-loopback")
        self.assertIn(
            "sink_input_properties=media.name=SmartAmp.background_bridge", loaded[1][1]
        )


if __name__ == "__main__":
    unittest.main()
