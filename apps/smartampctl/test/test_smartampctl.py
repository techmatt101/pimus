from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "src/smartampctl.py"
SPEC = importlib.util.spec_from_file_location("smartampctl", MODULE_PATH)
assert SPEC and SPEC.loader
smartampctl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smartampctl)


class SmartampctlTests(unittest.TestCase):
    def test_source_toggle_flips_and_persists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio_state = Path(directory) / "audio-state.json"
            with mock.patch.object(smartampctl, "AUDIO_STATE", audio_state):
                self.assertEqual(smartampctl.source("aux", "toggle"), 0)
                self.assertTrue(json.loads(audio_state.read_text())["sources"]["aux"])
                self.assertEqual(smartampctl.source("aux", "toggle"), 0)
                self.assertFalse(json.loads(audio_state.read_text())["sources"]["aux"])
                self.assertEqual(smartampctl.source("usb", "on"), 0)
                self.assertTrue(json.loads(audio_state.read_text())["sources"]["usb"])

    def test_concurrent_toggles_are_serialized(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio_state = Path(directory) / "audio-state.json"
            with mock.patch.object(smartampctl, "AUDIO_STATE", audio_state):
                with mock.patch("builtins.print"):
                    with ThreadPoolExecutor(max_workers=10) as executor:
                        results = list(
                            executor.map(
                                lambda _index: smartampctl.source("aux", "toggle"),
                                range(50),
                            )
                        )
                self.assertEqual(results, [0] * 50)
                self.assertFalse(json.loads(audio_state.read_text())["sources"]["aux"])
                self.assertEqual(list(Path(directory).glob("*.lock")), [])
                self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_lights_cycle_wraps_and_recovers_unknown_modes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            led_state = Path(directory) / "led-state.json"
            with mock.patch.object(smartampctl, "LED_STATE", led_state):
                led_state.write_text(json.dumps({"mode": "doa", "color": "#00bcd4"}))
                smartampctl.lights("cycle")
                self.assertEqual(json.loads(led_state.read_text())["mode"], "ring")
                smartampctl.lights("cycle")
                self.assertEqual(json.loads(led_state.read_text())["mode"], "voice")

                led_state.write_text(json.dumps({"mode": "bogus"}))
                smartampctl.lights("cycle")
                self.assertEqual(json.loads(led_state.read_text())["mode"], "voice")

                smartampctl.lights("breath")
                self.assertEqual(json.loads(led_state.read_text())["mode"], "breath")

    def test_status_path_follows_the_state_directory_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(smartampctl, "STATE_DIR", Path(directory)):
                self.assertEqual(
                    smartampctl.status_path(),
                    Path(f"/run/user/{os.getuid()}/smartamp-audio-status.json"),
                )

    def test_missing_status_reads_as_empty(self) -> None:
        self.assertEqual(
            smartampctl.read_json(Path("/nonexistent/status.json"), {}), {}
        )


if __name__ == "__main__":
    unittest.main()
