from __future__ import annotations

import importlib.util
import json
import tempfile
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

    def test_state_defaults_are_persisted(self) -> None:
        config = {"sources": {"aux": {"enabled": True}, "usb": {"enabled": False}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio-state.json"
            state = audio_manager.load_state(path, config)
            self.assertEqual(state, {"sources": {"aux": True, "usb": False}})
            self.assertEqual(json.loads(path.read_text()), state)

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

    def test_duck_request_has_a_fail_safe_expiry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duck.json"
            path.write_text(json.dumps({"active": True, "updated_at": 100.0}))
            self.assertTrue(audio_manager.duck_request_active(path, 120, 150.0))
            self.assertFalse(audio_manager.duck_request_active(path, 120, 221.0))

            path.write_text(json.dumps({"active": False, "updated_at": 220.0}))
            self.assertFalse(audio_manager.duck_request_active(path, 120, 221.0))

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


if __name__ == "__main__":
    unittest.main()
