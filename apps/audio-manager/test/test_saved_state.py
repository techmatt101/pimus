"""Settings survive clean restarts before any playback or controller restore."""

from __future__ import annotations

# pyright: reportPrivateUsage=false

import json
import tempfile
from pathlib import Path
from typing import Any
from unittest import mock

from test_audio_manager import ManagerTestCase, completed, fake_run
from smartamp_audio import graph


class SavedStateTests(ManagerTestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state_path = Path(directory.name) / "state.json"
        self.config: dict[str, Any] = {
            "startup_volume_percent": 30,
            "music_bus": {"enabled": True, "sink_name": "background"},
            "voice_bus": {"volume_percent": 25},
            "sources": {
                "aux": {"enabled": True, "volume_percent": 80},
                "sendspin": {"volume_percent": 100},
            },
        }

    def test_only_clean_exit_saves_requested_settings(self) -> None:
        manager = self.make_manager(self.config, state_path=self.state_path)
        with self._patched_graph({"sinks": [{"name": "background", "index": 2}]}, fake_run):
            manager.set_music_volume(12)
            manager.set_music_mute(True)
            manager.set_voice_volume(18)
            manager.set_source_trim("aux", 45)
            manager.set_source_enabled("aux", False)
            manager.commands.apply(mock.Mock(), {"command": "set-duck", "active": True})
            manager.reconcile()
        self.assertFalse(self.state_path.exists())

        with mock.patch.object(manager, "_run", return_value=0):
            self.assertEqual(manager.execute(), 0)
        self.assertEqual(json.loads(self.state_path.read_text()), {
            "version": 1,
            "music_volume": 12,
            "music_muted": True,
            "voice_volume": 18,
            "sources": {
                "aux": {"trim": 45, "enabled": False},
                "sendspin": {"trim": 100},
            },
        })
        restored = self.make_manager(self.config, state_path=self.state_path)
        self.assertEqual((restored.music_volume, restored.vol_muted), (12, True))
        self.assertEqual(restored.voice_volume, 18)
        self.assertEqual(restored.mixer.trims["aux"], 45)
        self.assertFalse(restored.mixer.enabled["aux"])
        self.assertFalse(restored.commands.duck_requested)

    def test_stopping_while_waiting_for_pipewire_saves_without_starting_playback(self) -> None:
        manager = self.make_manager(self.config, state_path=self.state_path)
        with mock.patch.object(manager, "wait_for_pulse", side_effect=manager.stop), mock.patch.object(
            manager, "reconcile"
        ) as reconcile:
            self.assertEqual(manager.execute(), 0)
        reconcile.assert_not_called()
        self.assertEqual(json.loads(self.state_path.read_text())["music_volume"], 30)

    def test_unexpected_exit_keeps_the_previous_saved_state(self) -> None:
        previous = self._saved_document()
        self.state_path.write_text(json.dumps(previous))
        manager = self.make_manager(self.config, state_path=self.state_path)
        manager.music_volume = 99
        with mock.patch.object(manager, "_run", side_effect=RuntimeError("crashed")):
            with self.assertRaisesRegex(RuntimeError, "crashed"):
                manager.execute()
        self.assertEqual(json.loads(self.state_path.read_text()), previous)

    def test_missing_or_invalid_state_uses_configuration_defaults(self) -> None:
        cases = [
            None, "{", "[]", '{"version": 2}',
            json.dumps({**self._saved_document(), "music_volume": 101}),
            json.dumps({**self._saved_document(), "music_volume": True}),
            json.dumps({**self._saved_document(), "music_muted": "false"}),
            json.dumps({**self._saved_document(), "voice_volume": -1}),
            json.dumps({**self._saved_document(), "sources": {"aux": {"trim": 101}}}),
            json.dumps({**self._saved_document(), "sources": {"aux": {"trim": 45, "enabled": "false"}}}),
        ]
        for content in cases:
            with self.subTest(content=content):
                self.state_path.unlink(missing_ok=True)
                if content is not None:
                    self.state_path.write_text(content)
                with mock.patch("audio_manager.state.LOG.warning"):
                    manager = self.make_manager(self.config, state_path=self.state_path)
                self.assertEqual((manager.music_volume, manager.vol_muted), (30, False))
                self.assertEqual(manager.voice_volume, 25)
                self.assertEqual(manager.mixer.trims["aux"], 80)
                self.assertTrue(manager.mixer.enabled["aux"])

    def test_saved_sources_follow_the_current_configuration(self) -> None:
        self.state_path.write_text(json.dumps(self._saved_document()))
        self.config["sources"] = {
            "aux": {"volume_percent": 80},
            "usb": {"volume_percent": 60, "enabled": False},
        }
        manager = self.make_manager(self.config, state_path=self.state_path)
        self.assertEqual(manager.mixer.trims, {"aux": 45, "usb": 60})
        self.assertEqual(manager.mixer.enabled, {"usb": False})

    def test_failed_save_preserves_the_old_file_and_still_closes_resources(self) -> None:
        previous = self._saved_document()
        self.state_path.write_text(json.dumps(previous))
        manager = self.make_manager(self.config, state_path=self.state_path)
        manager.music_volume = 99
        with mock.patch.object(manager, "_run", return_value=0), mock.patch(
            "smartamp_audio.status.os.replace", side_effect=OSError("disk unavailable")
        ), self.assertLogs("audio_manager.daemon", level="WARNING"):
            self.assertEqual(manager.execute(), 0)
        self.assertEqual(json.loads(self.state_path.read_text()), previous)
        self.assertEqual(list(self.state_path.parent.iterdir()), [self.state_path])
        self.assertIsNone(manager.selector.get_map())

    def test_restored_mute_keeps_an_existing_player_silent_through_startup(self) -> None:
        self.state_path.write_text(json.dumps(self._saved_document()))
        manager = self.make_manager(self.config, state_path=self.state_path)
        output: graph.Node = {"name": "hifi", "description": "HiFiBerry", "index": 1,
                              "mute": False, "volume": {"mono": {"value_percent": "100%"}}}
        bus: graph.Node = {"name": "background", "index": 2, "owner_module": 20,
                           "mute": False, "volume": {"mono": {"value_percent": "100%"}}}
        bridge: graph.Node = {"index": 31, "owner_module": 21, "sink": 1,
                              "properties": {"media.name": "SmartAmp.music_bridge"},
                              "volume": {"mono": {"value_percent": "100%"}}}
        player: graph.Node = {"index": 40, "sink": 2, "corked": False}
        listings = {
            "sinks": [output, bus],
            "sources": [{"name": "background.monitor"}],
            "sink-inputs": [bridge, player],
            "modules": [
                {"index": 20, "name": "module-null-sink", "argument": "sink_name=background"},
                {"index": 21, "name": "module-loopback", "argument": "source=background.monitor sink=hifi"},
            ],
        }

        def run(*args: str, check: bool = True) -> Any:
            if args[1] == "get-default-sink":
                return completed(*args, stdout="background\n")
            if args[1] == "set-sink-mute" and args[2] == "hifi":
                if args[3] == "0":
                    self.assertTrue(graph.volume_is(bridge, 0))
                output["mute"] = args[3] == "1"
            if args[1] == "set-sink-input-volume" and args[2] == "31":
                self.assertEqual(args[3], "0%")
                bridge["volume"] = {"mono": {"value_percent": args[3]}}
            return fake_run(*args, check=check)

        with self._patched_graph(listings, run), mock.patch("smartamp_audio.volume.time.sleep"):
            manager.reconcile()
        self.assertFalse(output["mute"])
        self.assertTrue(graph.volume_is(bridge, 0))
        self.assertTrue(manager.vol_muted)

    @staticmethod
    def _saved_document() -> dict[str, Any]:
        return {
            "version": 1, "music_volume": 12, "music_muted": True, "voice_volume": 18,
            "sources": {"aux": {"trim": 45, "enabled": False}, "sendspin": {"trim": 100}},
        }
