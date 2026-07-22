from __future__ import annotations

import importlib.util
import json
import selectors
import socket
import subprocess
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "src/audio_manager.py"
SPEC = importlib.util.spec_from_file_location("audio_manager", MODULE_PATH)
assert SPEC and SPEC.loader
audio_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audio_manager)


class AudioManagerTests(unittest.TestCase):
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
        selected = audio_manager.find_node(nodes, "XVF3800")
        self.assertEqual(selected["name"], "alsa_input.usb-XVF3800")

    def test_device_match_searches_properties(self) -> None:
        nodes = [{"name": "source.1", "properties": {"device.product.name": "HiFiBerry DAC2 ADC Pro"}}]
        selected = audio_manager.find_node(nodes, "HiFiBerry")
        self.assertEqual(selected["name"], "source.1")

    def test_route_state_defaults_follow_config(self) -> None:
        config = {"sources": {"aux": {"enabled": True}, "usb": {"enabled": False}}}
        self.assertEqual(
            audio_manager.default_sources(config), {"aux": True, "usb": False}
        )

    def test_route_commands_update_memory_state(self) -> None:
        manager = self._duckable_manager()
        manager.sources = {"aux": True, "usb": False}
        connection = mock.Mock()

        reply, reconcile = manager.apply_command(
            connection, {"command": "set-source", "name": "usb", "state": "toggle"}
        )
        self.assertEqual(
            reply,
            {"event": "state", "sources": {"aux": True, "usb": True}, "ducked": False},
        )
        self.assertTrue(reconcile)

        # Re-applying the current state must not trigger graph work.
        _, reconcile = manager.apply_command(
            connection, {"command": "set-source", "name": "usb", "state": "on"}
        )
        self.assertFalse(reconcile)

        reply, reconcile = manager.apply_command(
            connection, {"command": "set-source", "name": "phono", "state": "on"}
        )
        self.assertEqual(reply["event"], "error")
        self.assertFalse(reconcile)

    def test_reconnect_sync_adopts_only_configured_boolean_sources(self) -> None:
        manager = self._duckable_manager()
        manager.sources = {"aux": True, "usb": False}
        reply, reconcile = manager.apply_command(
            mock.Mock(),
            {
                "command": "set-sources",
                "sources": {"aux": False, "usb": "yes", "bogus": True},
            },
        )
        # Unknown routes and non-boolean values are ignored, not coerced.
        self.assertEqual(
            reply,
            {"event": "state", "sources": {"aux": False, "usb": False}, "ducked": False},
        )
        self.assertTrue(reconcile)

    def test_subscribe_lines_filter_out_self_inflicted_noise(self) -> None:
        self.assertTrue(audio_manager.is_relevant_event("Event 'change' on sink #43"))
        self.assertTrue(audio_manager.is_relevant_event("Event 'remove' on module #7"))
        # pactl invocations from our own reconcile emit client events; reacting
        # to them would reconcile forever.
        self.assertFalse(audio_manager.is_relevant_event("Event 'new' on client #99"))
        self.assertFalse(audio_manager.is_relevant_event("garbage"))

    def test_socket_commands_reconcile_and_answer_with_live_state(self) -> None:
        manager = self._duckable_manager()
        manager.sources = {"aux": False}
        manager.selector = selectors.DefaultSelector()
        manager.safe_reconcile = mock.Mock()
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        left.setblocking(False)
        manager.clients = {left: b""}
        manager.selector.register(left, selectors.EVENT_READ, lambda: None)

        right.sendall(b'{"command": "set-source", "name": "aux", "state": "on"}\n')
        manager.read_client(left)

        self.assertEqual(
            json.loads(right.recv(4096)),
            {"event": "state", "sources": {"aux": True}, "ducked": False},
        )
        manager.safe_reconcile.assert_called_once()

        right.sendall(b"not json\n")
        manager.read_client(left)
        self.assertEqual(json.loads(right.recv(4096))["event"], "error")

    def test_flooding_client_is_dropped(self) -> None:
        manager = self._duckable_manager()
        manager.selector = selectors.DefaultSelector()
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        left.setblocking(False)
        manager.clients = {left: b"x" * audio_manager.MAX_CLIENT_BUFFER_BYTES}
        manager.selector.register(left, selectors.EVENT_READ, lambda: None)

        right.sendall(b"y")
        manager.read_client(left)
        self.assertEqual(manager.clients, {})

    def test_owned_stream_matches_numeric_or_string_module_id(self) -> None:
        streams = [
            {"index": 10, "owner_module": 7},
            {"index": 11, "owner_module": "8"},
        ]
        self.assertEqual(audio_manager.find_owned_stream(streams, 8)["index"], 11)
        self.assertIsNone(audio_manager.find_owned_stream(streams, 9))

        tagged = [
            {"index": 12, "properties": {"media.name": "SmartAmp.background_bridge"}}
        ]
        self.assertEqual(
            audio_manager.find_owned_stream(
                tagged, 8, "SmartAmp.background_bridge"
            )["index"],
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
        selected = audio_manager.find_loaded_module(
            modules,
            "module-loopback",
            ("source=background.monitor", "sink=hifiberry"),
        )
        self.assertEqual(selected["index"], 12)

    @staticmethod
    def _duckable_manager() -> audio_manager.AudioManager:
        manager = audio_manager.AudioManager.__new__(audio_manager.AudioManager)
        manager.config = {"background": {"enabled": True}}
        manager.duck_requests = set()
        manager.sources = {}
        manager.clients = {}
        manager.running = True
        manager.background_stream_index = None
        manager.background_ducked = None
        return manager

    def test_duck_requests_are_held_against_the_requesting_connection(self) -> None:
        manager = self._duckable_manager()
        connection = mock.Mock()

        reply, needs_reconcile = manager.apply_command(
            connection, {"command": "set-duck", "active": True}
        )
        self.assertTrue(reply["ducked"])
        # Ducking only changes one stream volume, so it must not force a full
        # graph reconcile.
        self.assertFalse(needs_reconcile)
        self.assertTrue(manager.desired_ducking())

        manager.apply_command(connection, {"command": "set-duck", "active": False})
        self.assertFalse(manager.desired_ducking())

    def test_a_disconnecting_controller_releases_its_duck_request(self) -> None:
        manager = self._duckable_manager()
        manager.selector = mock.Mock()
        connection = mock.Mock()
        manager.clients[connection] = b""

        manager.apply_command(connection, {"command": "set-duck", "active": True})
        self.assertTrue(manager.desired_ducking())

        # Losing the socket is the liveness signal: a controller that crashes
        # mid-conversation must not leave background audio ducked.
        manager.drop_client(connection)
        self.assertFalse(manager.desired_ducking())
        self.assertEqual(manager.duck_requests, set())

    def test_ducking_stays_off_when_the_background_path_is_disabled(self) -> None:
        manager = self._duckable_manager()
        manager.config = {"background": {"enabled": False}}
        manager.duck_requests = {mock.Mock()}
        self.assertFalse(manager.desired_ducking())

    def test_set_duck_rejects_a_non_boolean_request(self) -> None:
        manager = self._duckable_manager()
        reply, _ = manager.apply_command(
            mock.Mock(), {"command": "set-duck", "active": "yes"}
        )
        self.assertEqual(reply["event"], "error")
        self.assertFalse(manager.desired_ducking())

    def test_background_bridge_fades_without_changing_client_volumes(self) -> None:
        manager = audio_manager.AudioManager.__new__(audio_manager.AudioManager)
        manager.config = {
            "background": {"duck_volume_percent": 15, "fade_ms": 100}
        }
        manager.background_stream_index = 42
        manager.background_ducked = False

        with mock.patch.object(audio_manager, "run") as pactl_run, mock.patch.object(
            audio_manager.time, "sleep"
        ):
            manager.set_background_ducking(True)

        self.assertEqual(
            [call.args[-1] for call in pactl_run.call_args_list], ["58%", "15%"]
        )
        self.assertTrue(manager.background_ducked)

    def test_background_sink_is_bridged_and_identifiable(self) -> None:
        manager = audio_manager.AudioManager.__new__(audio_manager.AudioManager)
        manager.config = {"background": {"enabled": True, "sink_name": "background"}}
        manager.modules = {}
        manager.bindings = {}
        manager.background_stream_index = None
        manager.background_ducked = None
        output = {"name": "hifiberry"}
        background = {"name": "background", "owner_module": 10}
        loaded = []

        def load_module(name: str, module: str, *arguments: str) -> int:
            module_id = 10 if name == "_background_sink" else 11
            manager.modules[name] = module_id
            loaded.append((name, module, arguments))
            return module_id

        responses = {
            "sinks": [output, background],
            "sources": [{"name": "background.monitor"}],
            "modules": [],
            "sink-inputs": [{"index": 21, "owner_module": 11}],
        }
        manager.load_module = load_module
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ):
            selected, _, _ = manager.ensure_background([output], [], output)

        self.assertEqual(selected, background)
        self.assertEqual(manager.background_stream_index, 21)
        self.assertEqual(loaded[0][0:2], ("_background_sink", "module-null-sink"))
        self.assertIn("priority.session=1", loaded[0][2][-1])
        self.assertEqual(loaded[1][0:2], ("_background_bridge", "module-loopback"))
        self.assertIn(
            "sink_input_properties=media.name=SmartAmp.background_bridge",
            loaded[1][2],
        )

    @staticmethod
    def _reconciling_manager() -> audio_manager.AudioManager:
        manager = audio_manager.AudioManager.__new__(audio_manager.AudioManager)
        manager.config = {
            "output_match": "HiFiBerry",
            "voice_input_match": "XVF3800",
            "aec_reference": {"enabled": True, "sink_match": "XVF3800", "latency_ms": 40},
            "background": {"enabled": False},
            "sources": {},
        }
        manager.status_path = Path("/unused/status.json")
        manager.modules = {}
        manager.bindings = {}
        manager.sources = {}
        manager.duck_requests = set()
        manager.background_stream_index = None
        manager.background_ducked = None
        return manager

    @staticmethod
    def _fake_run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        defaults = {"get-default-sink": "hifiberry", "get-default-source": "xvf_mic"}
        stdout = next(
            (name + "\n" for key, name in defaults.items() if key in args), ""
        )
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

    def test_aec_reference_bridges_output_monitor_into_the_xvf3800(self) -> None:
        manager = self._reconciling_manager()
        loaded = []

        def load_module(name: str, module: str, *arguments: str) -> int:
            manager.modules[name] = 30
            loaded.append((name, module, arguments))
            return 30

        manager.load_module = load_module
        responses = {
            "modules": [],
            "sinks": [
                {"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"},
                {"name": "xvf_playback", "description": "reSpeaker XVF3800"},
            ],
            "sources": [
                {"name": "hifiberry.monitor", "monitor_of_sink": 0},
                {
                    "name": "xvf_mic",
                    "description": "reSpeaker XVF3800 Mic Array",
                    "monitor_of_sink": 4294967295,
                },
            ],
        }
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ), mock.patch.object(
            audio_manager, "run", side_effect=self._fake_run
        ), mock.patch.object(audio_manager, "atomic_json") as status_write:
            manager.reconcile()

        # The far-end reference is what the room hears: the output sink's
        # monitor looped into the XVF3800 playback endpoint.
        self.assertEqual(loaded, [
            (
                "_aec",
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
        ])
        status = status_write.call_args.args[1]
        self.assertEqual(
            status["aec_reference"],
            {"enabled": True, "available": True, "sink": "xvf_playback"},
        )

    def test_aec_reference_is_released_when_the_xvf3800_disappears(self) -> None:
        manager = self._reconciling_manager()
        manager.modules = {"_aec": 30}
        manager.bindings = {"_aec": ("hifiberry.monitor", "xvf_playback")}
        responses = {
            "modules": [{"index": 30}],
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [{"name": "hifiberry.monitor", "monitor_of_sink": 0}],
        }
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ), mock.patch.object(
            audio_manager, "run", side_effect=self._fake_run
        ) as pactl_run, mock.patch.object(audio_manager, "atomic_json") as status_write:
            manager.reconcile()

        self.assertNotIn("_aec", manager.modules)
        self.assertIn(
            ("pactl", "unload-module", "30"),
            [call.args for call in pactl_run.call_args_list],
        )
        status = status_write.call_args.args[1]
        self.assertEqual(
            status["aec_reference"],
            {"enabled": True, "available": False, "sink": None},
        )


if __name__ == "__main__":
    unittest.main()
