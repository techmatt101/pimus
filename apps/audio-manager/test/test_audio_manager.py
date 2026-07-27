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
            {"event": "state", "sources": {"aux": True, "usb": True}, "ducked": False, "usb_playback": False, "music_volume": 100, "voice_volume": 100},
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
            {"event": "state", "sources": {"aux": False, "usb": False}, "ducked": False, "usb_playback": False, "music_volume": 100, "voice_volume": 100},
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
            {"event": "state", "sources": {"aux": True}, "ducked": False, "usb_playback": False, "music_volume": 100, "voice_volume": 100},
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
        completed = subprocess.CompletedProcess(
            ("pactl", "list", "short", "modules"), 0, stdout=listing, stderr=""
        )
        with mock.patch.object(audio_manager, "run", return_value=completed):
            modules = audio_manager.pactl_modules()

        self.assertEqual(
            [module["index"] for module in modules], [1, 536870912]
        )
        selected = audio_manager.find_loaded_module(
            modules,
            "module-loopback",
            ("source=background.monitor", "sink=hifiberry"),
        )
        self.assertEqual(selected["index"], 536870912)

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

    def test_usb_host_detection_reads_the_udc_state_file(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as base:
            root = Path(base)
            self.assertFalse(audio_manager.usb_host_attached(root))

            udc = root / "1000480000.usb"
            udc.mkdir()
            (udc / "state").write_text("not attached\n", encoding="utf-8")
            self.assertFalse(audio_manager.usb_host_attached(root))

            (udc / "state").write_text("configured\n", encoding="utf-8")
            self.assertTrue(audio_manager.usb_host_attached(root))

        self.assertFalse(audio_manager.usb_host_attached(root / "missing"))

    def test_usb_streaming_detection_reads_the_gadget_rate_control(self) -> None:
        def completed(returncode: int, stdout: str) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(("amixer",), returncode, stdout, "")

        listing = (
            "numid=4,iface=PCM,name='Capture Rate'\n"
            "  ; type=INTEGER,access=r--v----,values=1,min=48000,max=48000,step=0\n"
            "  : values={rate}\n"
        )
        cases = [
            (completed(0, listing.format(rate=48000)), True),
            (completed(0, listing.format(rate=0)), False),
            (completed(1, ""), False),
            (completed(0, "garbage"), False),
        ]
        for result, expected in cases:
            with mock.patch.object(audio_manager, "run", return_value=result):
                self.assertEqual(audio_manager.usb_gadget_streaming(), expected)

    def test_usb_route_bridges_only_while_the_host_is_streaming(self) -> None:
        manager = self._reconciling_manager()
        manager.config["aec_reference"] = {"enabled": False}
        manager.config["sources"] = {
            "usb": {"match": "UAC2Gadget", "requires_usb_host": True, "latency_ms": 20}
        }
        manager.sources = {"usb": True}
        loaded: list[str] = []

        def load_module(name: str, module: str, *arguments: str) -> int:
            manager.modules[name] = 50
            loaded.append(name)
            return 50

        manager.load_module = load_module
        responses = {
            "modules": [],
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [
                {
                    "name": "uac2_capture",
                    "description": "UAC2Gadget",
                    "monitor_of_sink": 4294967295,
                }
            ],
            "sink-inputs": [],
            "cards": [],
        }
        commands: list[tuple[str, ...]] = []

        def fake_run(*args: str, check: bool = True) -> object:
            commands.append(args)
            return self._fake_run(*args, check=check)

        def reconcile(attached: bool, streaming: bool) -> dict[str, object]:
            with mock.patch.object(
                audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
            ), mock.patch.object(
                audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
            ), mock.patch.object(
                audio_manager, "run", side_effect=fake_run
            ), mock.patch.object(
                audio_manager, "usb_host_attached", return_value=attached
            ), mock.patch.object(
                audio_manager, "usb_gadget_streaming", return_value=streaming
            ), mock.patch.object(audio_manager, "atomic_json") as status_write:
                manager.reconcile()
            return status_write.call_args.args[1]

        # The gadget card boots parked in its "off" profile (it has no mixer,
        # so WirePlumber never activates a profile itself) and offers no
        # capture node until the manager switches it on.
        capture_node = responses["sources"]
        responses["sources"] = []
        responses["cards"] = [
            {
                "name": "alsa_card.platform-1000480000.usb",
                "properties": {"alsa.id": "UAC2Gadget"},
                "profiles": {"off": {}, "pro-audio": {}},
                "active_profile": "off",
            }
        ]
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
        responses["sources"] = capture_node
        responses["cards"][0]["active_profile"] = "pro-audio"

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
        self.assertEqual(loaded, ["usb"])
        self.assertTrue(status["usb_playback"])
        self.assertTrue(status["sources"]["usb"]["available"])

        status = reconcile(attached=True, streaming=False)
        self.assertNotIn("usb", manager.modules)
        self.assertFalse(status["sources"]["usb"]["available"])

    def test_usb_volume_sync_follows_whichever_side_moved(self) -> None:
        manager = self._reconciling_manager()
        manager.config["aec_reference"] = {"enabled": False}
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
        responses = {"modules": [], "sinks": sinks, "sources": []}
        commands: list[tuple[str, ...]] = []

        def fake_run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
            commands.append(args)
            if args[0] == "amixer" and "sget" in args:
                state = f"[{gadget['volume']}%] [{'off' if gadget['muted'] else 'on'}]"
                return subprocess.CompletedProcess(
                    args, 0, stdout=f"  Mono: Capture 123 {state}\n", stderr=""
                )
            if args[0] == "amixer" and "sset" in args:
                gadget["volume"] = int(args[6].rstrip("%"))
                gadget["muted"] = args[7] == "nocap"
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            if args[:2] == ("pactl", "set-sink-mute"):
                sinks[0]["mute"] = args[3] == "1"
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            return self._fake_run(*args, check=check)

        def reconcile() -> None:
            with mock.patch.object(
                audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
            ), mock.patch.object(
                audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
            ), mock.patch.object(
                audio_manager, "run", side_effect=fake_run
            ), mock.patch.object(
                audio_manager, "usb_gadget_card_present", return_value=True
            ), mock.patch.object(
                audio_manager, "usb_host_attached", return_value=True
            ), mock.patch.object(audio_manager, "atomic_json"):
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

    def test_muted_route_keeps_its_bridge_and_toggles_by_fading(self) -> None:
        manager = self._reconciling_manager()
        manager.config["aec_reference"] = {"enabled": False}
        manager.config["sources"] = {
            "aux": {"match": "ADC Pro", "mute_when_off": True, "latency_ms": 20}
        }
        manager.sources = {"aux": False}
        loaded: list[str] = []
        responses = {
            "modules": [],
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [
                {
                    "name": "hifiberry_adc",
                    "description": "HiFiBerry DAC2 ADC Pro",
                    "monitor_of_sink": 4294967295,
                }
            ],
            "sink-inputs": [{"index": 61, "owner_module": 60}],
        }

        def load_module(name: str, module: str, *arguments: str) -> int:
            manager.modules[name] = 60
            responses["modules"].append(
                {"index": 60, "name": module, "argument": " ".join(arguments)}
            )
            loaded.append(name)
            return 60

        manager.load_module = load_module

        def reconcile() -> list[str]:
            with mock.patch.object(
                audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
            ), mock.patch.object(
                audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
            ), mock.patch.object(
                audio_manager, "run", side_effect=self._fake_run
            ) as pactl_run, mock.patch.object(
                audio_manager.time, "sleep"
            ), mock.patch.object(audio_manager, "atomic_json"):
                manager.reconcile()
            return [
                call.args[-1]
                for call in pactl_run.call_args_list
                if "set-sink-input-volume" in call.args
            ]

        # Off at boot: the bridge still loads, snapped straight to silent so
        # the pop-prone stream connect happens once, before anything plays.
        self.assertEqual(reconcile(), ["0%"])
        self.assertEqual(loaded, ["aux"])

        # Turning the route on is a fade, not a module load.
        manager.sources["aux"] = True
        volumes = reconcile()
        self.assertEqual(loaded, ["aux"])
        self.assertGreater(len(volumes), 1)
        self.assertEqual(volumes[-1], "100%")

        manager.sources["aux"] = False
        volumes = reconcile()
        self.assertEqual(volumes[-1], "0%")

        # A settled toggle fades nothing on the next reconcile.
        self.assertEqual(reconcile(), [])

    def test_output_sink_is_pinned_to_full_scale(self) -> None:
        manager = self._duckable_manager()

        with mock.patch.object(audio_manager, "run") as run:
            manager.pin_output_volume(None)
            run.assert_not_called()

            # WirePlumber restored an old dial level: pin it back to 100.
            manager.pin_output_volume(
                {"name": "hifi", "volume": {"mono": {"value_percent": "20%"}}}
            )
            run.assert_called_once_with(
                "pactl", "set-sink-volume", "hifi", "100%", check=False
            )

            # An already pinned sink writes nothing, so the pin can never echo
            # itself into another reconcile.
            manager.pin_output_volume(
                {"name": "hifi", "volume": {"mono": {"value_percent": "100%"}}}
            )
            run.assert_called_once()

    def test_startup_config_seeds_the_music_and_voice_levels(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as base:
            config = Path(base) / "audio.json"
            config.write_text(
                json.dumps({
                    "startup_volume_percent": 20,
                    "voice_bus": {"enabled": True, "volume_percent": 50},
                    "sources": {},
                }),
                encoding="utf-8",
            )
            with mock.patch.object(audio_manager, "usb_host_attached", return_value=False):
                manager = audio_manager.AudioManager(
                    config, Path(base) / "control.sock", Path(base) / "status.json"
                )
            self.addCleanup(manager.selector.close)
        self.assertEqual(manager.music_volume, 20)
        self.assertEqual(manager.voice_volume, 50)

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
        manager.background_gain_applied = 100

        with mock.patch.object(audio_manager, "run") as pactl_run, mock.patch.object(
            audio_manager.time, "sleep"
        ):
            manager.set_background_ducking(True)

        self.assertEqual(
            [call.args[-1] for call in pactl_run.call_args_list], ["58%", "15%"]
        )
        self.assertTrue(manager.background_ducked)

    def test_voice_volume_command_applies_the_bridge_gain(self) -> None:
        manager = self._duckable_manager()
        manager.config = {
            "background": {"enabled": False},
            "voice_bus": {"enabled": True},
        }
        manager.voice_stream_index = 33

        with mock.patch.object(audio_manager, "run") as pactl_run:
            reply, reconcile = manager.apply_command(
                mock.Mock(), {"command": "set-voice-volume", "percent": 40}
            )

        self.assertEqual(reply["voice_volume"], 40)
        # One stream volume, like ducking: never a full graph reconcile.
        self.assertFalse(reconcile)
        # The sink is pinned, so the bridge gain is the voice level itself,
        # whatever the music is doing.
        pactl_run.assert_called_once_with(
            "pactl", "set-sink-input-volume", "33", "40%", check=False
        )

    def test_voice_volume_rejects_anything_but_a_percent(self) -> None:
        manager = self._duckable_manager()
        for percent in ("50", True, -1, 101, None):
            reply, reconcile = manager.apply_command(
                mock.Mock(), {"command": "set-voice-volume", "percent": percent}
            )
            self.assertEqual(reply["event"], "error")
            self.assertFalse(reconcile)
        self.assertEqual(manager.voice_volume, 100)

    def test_music_volume_command_moves_the_bus_and_direct_routes(self) -> None:
        manager = self._duckable_manager()
        manager.config = {
            "background": {"enabled": True, "duck_volume_percent": 15, "fade_ms": 0},
            "sources": {"aux": {"match": "ADC Pro", "mute_when_off": True, "latency_ms": 20}},
        }
        manager.modules = {"aux": 60}
        manager.route_unmuted = {"aux": True}
        manager.background_stream_index = 42
        manager.background_ducked = False
        manager.background_gain_applied = 100
        sink_inputs = [
            {
                "index": 61,
                "owner_module": 60,
                "volume": {"mono": {"value_percent": "100%"}},
            }
        ]

        with mock.patch.object(
            audio_manager, "pactl_json", return_value=sink_inputs
        ), mock.patch.object(audio_manager, "run") as pactl_run, mock.patch.object(
            audio_manager.time, "sleep"
        ):
            reply, reconcile = manager.apply_command(
                mock.Mock(), {"command": "set-music-volume", "percent": 30}
            )

        self.assertEqual(reply["music_volume"], 30)
        self.assertFalse(reconcile)
        writes = [
            (call.args[2], call.args[3])
            for call in pactl_run.call_args_list
            if "set-sink-input-volume" in call.args
        ]
        # The background bus snaps to the new level and the unmuted aux bridge
        # follows it; the voice bridge is left alone.
        self.assertEqual(writes, [("42", "30%"), ("61", "30%")])

    def test_ducked_music_dips_by_the_duck_share_of_the_music_level(self) -> None:
        manager = audio_manager.AudioManager.__new__(audio_manager.AudioManager)
        manager.config = {"background": {"duck_volume_percent": 15}}
        manager.music_volume = 60
        self.assertEqual(manager.background_target(False), 60)
        self.assertEqual(manager.background_target(True), 9)

    def test_voice_bus_is_bridged_and_a_new_stream_is_snapped_to_the_gain(self) -> None:
        manager = audio_manager.AudioManager.__new__(audio_manager.AudioManager)
        manager.config = {
            "voice_bus": {"enabled": True, "sink_name": "smartamp_voice", "latency_ms": 40}
        }
        manager.modules = {}
        manager.bindings = {}
        manager.voice_volume = 40
        manager.voice_stream_index = None
        manager.voice_gain_applied = None
        output = {
            "name": "hifiberry",
            "mute": False,
            "volume": {"mono": {"value_percent": "80%"}},
        }
        voice = {"name": "smartamp_voice", "owner_module": 12}
        loaded = []

        def load_module(name: str, module: str, *arguments: str) -> int:
            module_id = 12 if name == "_voice_sink" else 13
            manager.modules[name] = module_id
            loaded.append((name, module, arguments))
            return module_id

        responses = {
            "sinks": [output, voice],
            "sources": [{"name": "smartamp_voice.monitor"}],
            "modules": [],
            "sink-inputs": [{"index": 27, "owner_module": 13}],
        }
        manager.load_module = load_module
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ), mock.patch.object(
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
        ), mock.patch.object(audio_manager, "run") as pactl_run:
            selected, _, _ = manager.ensure_voice_bus([output], [], output)
            manager.apply_voice_gain()

        self.assertEqual(selected, voice)
        self.assertEqual(manager.voice_stream_index, 27)
        self.assertEqual(loaded[0][0:2], ("_voice_sink", "module-null-sink"))
        self.assertIn("priority.session=1", loaded[0][2][-1])
        self.assertEqual(loaded[1][0:2], ("_voice_bridge", "module-loopback"))
        self.assertIn(
            "sink_input_properties=media.name=SmartAmp.voice_bridge",
            loaded[1][2],
        )
        pactl_run.assert_called_once_with(
            "pactl", "set-sink-input-volume", "27", "40%", check=False
        )

        # A settled bus writes nothing on the next pass.
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ), mock.patch.object(
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
        ), mock.patch.object(audio_manager, "run") as pactl_run:
            manager.ensure_voice_bus(responses["sinks"], responses["sources"], output)
            manager.apply_voice_gain()
        pactl_run.assert_not_called()

    def test_background_sink_is_bridged_and_identifiable(self) -> None:
        manager = audio_manager.AudioManager.__new__(audio_manager.AudioManager)
        manager.config = {"background": {"enabled": True, "sink_name": "background", "latency_ms": 40}}
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
        ), mock.patch.object(
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
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
        manager.route_unmuted = {}
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
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
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

    def test_voice_capture_publishes_the_asr_channel_as_the_default_source(self) -> None:
        manager = self._reconciling_manager()
        manager.config["voice_capture_channel"] = 1
        manager.config["aec_reference"] = {"enabled": False}
        loaded = []

        def load_module(name: str, module: str, *arguments: str) -> int:
            manager.modules[name] = 40
            loaded.append((name, module, arguments))
            return 40

        manager.load_module = load_module
        responses = {
            "modules": [],
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
        }
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ), mock.patch.object(
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
        ), mock.patch.object(
            audio_manager, "run", side_effect=self._fake_run
        ) as pactl_run, mock.patch.object(audio_manager, "atomic_json") as status_write:
            manager.reconcile()

        # Channel 1 is the XVF3800's ASR output; front-right is its label in
        # the device channel map. remix=no keeps the Conference channel out.
        self.assertEqual(loaded, [
            (
                "_voice_capture",
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
        ])
        self.assertIn(
            ("pactl", "set-default-source", "smartamp_voice_capture"),
            [call.args for call in pactl_run.call_args_list],
        )
        status = status_write.call_args.args[1]
        self.assertEqual(status["voice_input"], "xvf_mic")
        self.assertEqual(
            status["voice_capture"],
            {"channel": 1, "source": "smartamp_voice_capture"},
        )

    def test_voice_capture_falls_back_to_the_device_without_that_channel(self) -> None:
        manager = self._reconciling_manager()
        manager.config["voice_capture_channel"] = 1
        manager.config["aec_reference"] = {"enabled": False}
        manager.load_module = mock.Mock()
        responses = {
            "modules": [],
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [
                {
                    "name": "mono_mic",
                    "description": "reSpeaker XVF3800 Mic Array",
                    "monitor_of_sink": 4294967295,
                    "channel_map": "mono",
                }
            ],
        }
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ), mock.patch.object(
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
        ), mock.patch.object(
            audio_manager, "run", side_effect=self._fake_run
        ) as pactl_run, mock.patch.object(audio_manager, "atomic_json") as status_write:
            manager.reconcile()

        manager.load_module.assert_not_called()
        self.assertIn(
            ("pactl", "set-default-source", "mono_mic"),
            [call.args for call in pactl_run.call_args_list],
        )
        status = status_write.call_args.args[1]
        self.assertEqual(
            status["voice_capture"], {"channel": 1, "source": None}
        )

    def test_voice_capture_is_released_when_the_xvf3800_disappears(self) -> None:
        manager = self._reconciling_manager()
        manager.config["voice_capture_channel"] = 1
        manager.config["aec_reference"] = {"enabled": False}
        manager.modules = {"_voice_capture": 40}
        manager.bindings = {"_voice_capture": ("xvf_mic", "front-right")}
        responses = {
            "modules": [{"index": 40}],
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [{"name": "hifiberry.monitor", "monitor_of_sink": 0}],
        }
        with mock.patch.object(
            audio_manager, "pactl_json", side_effect=lambda kind: responses[kind]
        ), mock.patch.object(
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
        ), mock.patch.object(
            audio_manager, "run", side_effect=self._fake_run
        ) as pactl_run, mock.patch.object(audio_manager, "atomic_json"):
            manager.reconcile()

        self.assertNotIn("_voice_capture", manager.modules)
        self.assertIn(
            ("pactl", "unload-module", "40"),
            [call.args for call in pactl_run.call_args_list],
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
            audio_manager, "pactl_modules", side_effect=lambda: responses["modules"]
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
