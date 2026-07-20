from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "src/python/audio_manager.py"
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


if __name__ == "__main__":
    unittest.main()
