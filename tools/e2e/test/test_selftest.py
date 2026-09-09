from __future__ import annotations

import json
import math
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, cast
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parents[3] / "libs/audio-common/src"))

from selftest import audio
from selftest.config import SelftestConfig
from selftest.control import ControlClient, section
from selftest.report import Check, Outcome, Report
from selftest.runtime import Runtime
from selftest.session import Levels, Options, Session
from selftest.tiers import TIERS, commands, services
from smartamp_audio import process


OFFICE = {
    "service_user": "smartamp",
    "uid": 1001,
    "runtime_dir": "/run/user/1001",
    "inputs_status": "/run/user/1001/smartamp-audio-inputs-status.json",
    "output_match": "HiFiBerry|snd_rpi_hifiberry|soc_sound",
    "music_sink": "smartamp_music",
    "voice_sink": "smartamp_voice",
    "duck_volume_percent": 15,
    "idle_teardown": True,
    "ceiling": {"card": "sndrpihifiberry", "control": "Digital", "percent": 90},
    "sources": {"sendspin": {"switchable": False}, "usb": {"switchable": True}},
    "voice": {
        "enabled": True,
        "input_name": "smartamp_voice_input",
        "capture_name": "smartamp_voice_capture",
        "ducking": True,
    },
    "aec_reference": True,
    "respeaker": {
        "label": "ReSpeaker XVF3800 USB 4-Mic Array",
        "usb_id": "2886:001a",
        "host_control": True,
        "led": True,
    },
    "streamdeck": {"label": "Elgato Stream Deck+", "usb_id": "0fd9:0084"},
    "usb_ports": ["/sys/bus/usb/devices/usb1/1-1/1-1:1.0/usb1-port1/disable"],
    "services": ["smartamp-hifiberry", "smartamp-audio-manager", "smartamp-sendspin",
                 "smartamp-voice-assistant"],
    "controller": True,
    "home_assistant": True,
    "acoustic": {"music_volume": 40, "noise_seconds": 5, "min_rise_db": 6},
}


def completed(*args: str, returncode: int = 0, stdout: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr="")


class ConfigTests(unittest.TestCase):
    def test_the_unit_is_described_by_what_it_has(self) -> None:
        config = SelftestConfig.from_mapping(OFFICE)
        self.assertEqual(str(config.socket), "/run/user/1001/smartamp-audio.sock")
        self.assertEqual(config.switchable_sources, ["usb"])
        self.assertIsNotNone(config.ceiling)
        self.assertEqual(config.voice.capture_name, "smartamp_voice_capture")
        self.assertTrue(config.respeaker and config.respeaker.host_control)

    def test_a_unit_without_a_feature_parses_it_as_absent(self) -> None:
        bare = {**OFFICE, "ceiling": None, "respeaker": None, "streamdeck": None,
                "inputs_status": None, "usb_ports": [], "voice": {"enabled": False}}
        config = SelftestConfig.from_mapping(bare)
        self.assertIsNone(config.ceiling)
        self.assertIsNone(config.respeaker)
        self.assertIsNone(config.streamdeck)
        self.assertIsNone(config.inputs_status)
        self.assertFalse(config.voice.enabled)
        self.assertIsNone(config.voice.capture_name)


class ReportTests(unittest.TestCase):
    def test_only_a_failure_fails_the_run(self) -> None:
        report = Report("office-amp")
        report.add(Check("services", "manager is active", Outcome.PASS))
        report.add(Check("acoustic", "converged", Outcome.WARN, "latched"))
        report.add(Check("recovery", "restart", Outcome.SKIP, "--restart"))
        self.assertEqual(report.exit_code, 0)
        report.add(Check("playback", "tone reaches the output", Outcome.FAIL, "silence"))
        self.assertEqual(report.exit_code, 1)
        text = report.render_text()
        self.assertIn("== playback ==", text)
        self.assertIn("FAIL  tone reaches the output: silence", text)
        self.assertIn("1 pass, 1 warn, 1 fail, 1 skip", text)
        as_json = json.loads(report.render_json())
        self.assertFalse(as_json["ok"])
        self.assertEqual(as_json["counts"]["FAIL"], 1)


class RuntimeTests(unittest.TestCase):
    def test_audio_commands_run_in_the_service_accounts_session(self) -> None:
        runtime = Runtime(SelftestConfig.from_mapping(OFFICE))
        with mock.patch("os.geteuid", return_value=0):
            argv = runtime.as_service_user(["pactl", "info"])
        self.assertEqual(argv[:4], ["runuser", "-u", "smartamp", "--"])
        self.assertIn("PULSE_SERVER=/run/user/1001/pulse/native", argv)
        self.assertIn("LC_ALL=C", argv)
        self.assertEqual(argv[-2:], ["pactl", "info"])
        with mock.patch("os.geteuid", return_value=1001):
            self.assertEqual(runtime.as_service_user(["pactl"])[0], "env")

    def test_the_ceiling_is_the_lowest_playback_channel(self) -> None:
        runtime = Runtime(SelftestConfig.from_mapping(OFFICE))
        listing = (
            "Simple mixer control 'Digital',0\n"
            "  Limits: Playback 0 - 207\n"
            "  Front Left: Playback 178 [90%] [-6.00dB] [on]\n"
            "  Front Right: Playback 150 [70%] [-30.00dB] [on]\n"
        )
        with mock.patch.object(process, "run", return_value=completed(stdout=listing)):
            self.assertEqual(runtime.amixer_percent("sndrpihifiberry", "Digital"), 70)
        with mock.patch.object(process, "run", return_value=completed(returncode=1)):
            self.assertIsNone(runtime.amixer_percent("sndrpihifiberry", "Digital"))

    def test_a_failed_child_is_a_result_not_an_exception(self) -> None:
        runtime = Runtime(SelftestConfig.from_mapping(OFFICE))
        with mock.patch.object(process, "run", side_effect=OSError("no such binary")):
            self.assertIsNone(runtime.xvf_host("VERSION"))
            self.assertFalse(runtime.unit_active("smartamp-audio-manager"))


class FakeManager:
    """A daemon on a socketpair speaking the control protocol's shapes."""

    def __init__(self) -> None:
        server, client = socket.socketpair()
        self.server: socket.socket = server
        self.client: socket.socket = client
        self.state: dict[str, Any] = {
            "music_bus": {"volume": 30, "muted": False, "ducked": False},
            "sources": {"usb": {"trim": 100, "enabled": False, "available": False}},
        }
        self.commands: list[dict[str, Any]] = []
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self.client.close()
        self.server.close()

    def _serve(self) -> None:
        try:
            with self.server.makefile("rb") as lines:
                for line in lines:
                    message = cast(dict[str, Any], json.loads(line))
                    self.commands.append(message)
                    self._answer(message)
        except OSError:
            return

    def _answer(self, message: dict[str, Any]) -> None:
        command = message.get("command")
        if command == "set-music-volume":
            percent = message.get("percent")
            if not isinstance(percent, int) or not 0 <= percent <= 100:
                self._send({"event": "error", "error": "set-music-volume needs a percent"})
                return
            self.state["music_bus"]["volume"] = percent
            # The daemon answers, then its loop notices the change and
            # broadcasts the same state again.
            self._send({"event": "state", **self.state})
            self._send({"event": "state", **self.state})
        elif command == "set-source-state":
            self.state["sources"]["usb"]["enabled"] = not self.state["sources"]["usb"]["enabled"]
            # A reconciling command has no unicast reply, only the broadcast.
            self._send({"event": "state", **self.state})
        elif command == "get-state":
            self._send({"event": "state", **self.state})
        else:
            self._send({"event": "error", "error": f"unknown command {command!r}"})

    def _send(self, event: dict[str, Any]) -> None:
        self.server.sendall(json.dumps(event).encode() + b"\n")


class ControlClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = FakeManager()
        self.addCleanup(self.manager.close)
        self.control = ControlClient(Path("/nowhere"), timeout=2.0)
        self.control._socket = self.manager.client  # pyright: ignore[reportPrivateUsage]

    def test_a_stale_broadcast_is_not_taken_for_the_next_answer(self) -> None:
        first = self.control.command("set-music-volume", percent=42)
        self.assertEqual(section(first, "music_bus", "volume"), 42)
        second = self.control.command("set-music-volume", percent=55)
        self.assertEqual(section(second, "music_bus", "volume"), 55)
        self.assertEqual(self.control.command("no-such")["event"], "error")

    def test_a_reconciling_command_is_answered_by_its_broadcast(self) -> None:
        toggled = self.control.command("set-source-state", name="usb", state="toggle")
        self.assertTrue(section(toggled, "sources", "usb", "enabled"))
        self.assertEqual(self.manager.commands[-1],
                         {"command": "set-source-state", "name": "usb", "state": "toggle"})

    def test_wait_for_polls_until_the_state_agrees(self) -> None:
        self.control.command("set-music-volume", percent=10)
        found = self.control.wait_for(lambda s: section(s, "music_bus", "volume") == 10, 1.0)
        self.assertIsNotNone(found)
        missing = self.control.wait_for(lambda s: section(s, "music_bus", "volume") == 99, 0.3)
        self.assertIsNone(missing)


class AudioMathTests(unittest.TestCase):
    def test_a_level_is_a_cubic_gain(self) -> None:
        self.assertAlmostEqual(audio.expected_gain_db(100), 0.0)
        self.assertAlmostEqual(audio.expected_gain_db(50), 60 * math.log10(0.5))
        self.assertEqual(audio.expected_gain_db(0), audio.FLOOR_DB)

    def test_goertzel_finds_the_tone_and_nothing_else(self) -> None:
        rate = 48000
        samples = [0.1 * math.sin(2 * math.pi * 1000 * i / rate) for i in range(rate)]
        found = audio.analyse(samples, frequency=1000, rate=rate)
        self.assertAlmostEqual(found.tone_db, -20.0, delta=0.1)
        self.assertAlmostEqual(found.rms_db, -20.0 - 20 * math.log10(math.sqrt(2)), delta=0.1)
        elsewhere = audio.analyse(samples, frequency=3000, rate=rate)
        self.assertLess(elsewhere.tone_db, -60.0)
        self.assertEqual(audio.analyse([]).tone_db, audio.FLOOR_DB)

    def test_the_stimulus_files_are_stereo_wavs_at_the_asked_level(self) -> None:
        with tempfile.TemporaryDirectory() as base:
            tone = audio.write_tone(Path(base) / "tone.wav", 0.1)
            noise = audio.write_noise(Path(base) / "noise.wav", 0.1, amplitude=0.3)
            self.assertGreater(tone.stat().st_size, 44)
            self.assertGreater(noise.stat().st_size, 44)


class SessionTests(unittest.TestCase):
    def test_the_levels_found_are_the_levels_put_back(self) -> None:
        state = {
            "event": "state",
            "output_volume": 90,
            "music_bus": {"volume": 45, "muted": True},
            "voice_bus": {"volume": 30},
            "sources": {"sendspin": {"trim": 80}, "usb": {"trim": 60, "enabled": True}},
        }
        levels = Levels.of(state)
        self.assertEqual(levels.music_volume, 45)
        self.assertTrue(levels.music_muted)
        self.assertEqual(levels.trims, {"sendspin": 80, "usb": 60})
        self.assertEqual(levels.enabled, {"usb": True})

        config = SelftestConfig.from_mapping(OFFICE)
        session = Session(config, Runtime(config), Report("office-amp"), Options())
        session.levels = levels
        sent: list[dict[str, Any]] = []

        def record(name: str, /, **fields: Any) -> dict[str, Any]:
            sent.append({"command": name, **fields})
            return {}

        with mock.patch.object(session.control, "command", side_effect=record), \
                mock.patch.object(type(session.control), "connected", new=True):
            session.restore()
        self.assertIn({"command": "set-music-volume", "percent": 45}, sent)
        self.assertIn({"command": "set-music-mute", "muted": True}, sent)
        self.assertIn({"command": "set-output-ceiling", "percent": 90}, sent)
        self.assertIn({"command": "set-source-trim", "name": "usb", "percent": 60}, sent)
        self.assertIn({"command": "set-source-state", "name": "usb", "state": "on"}, sent)
        self.assertEqual(sent[0], {"command": "set-duck", "active": False})

    def test_a_playing_amp_skips_a_tier_unless_forced(self) -> None:
        config = SelftestConfig.from_mapping(OFFICE)
        report = Report("office-amp")
        session = Session(config, Runtime(config), report, Options())
        playing = [{"index": 7, "sink": 3, "corked": False,
                    "properties": {"media.name": "Music Assistant"}}]
        with mock.patch.object(session, "client_streams", return_value=playing):
            self.assertTrue(session.in_use("playback"))
            self.assertEqual(report.checks[-1].outcome, Outcome.SKIP)
            session.options.force = True
            self.assertFalse(session.in_use("playback"))

    def test_the_daemons_own_bridges_are_not_somebody_playing(self) -> None:
        config = SelftestConfig.from_mapping(OFFICE)
        session = Session(config, Runtime(config), Report("office-amp"), Options())
        listings: dict[str, list[dict[str, Any]]] = {
            "sinks": [{"index": 3, "name": "smartamp_music"}],
            "sink-inputs": [
                {"index": 1, "sink": 3, "properties": {"media.name": "SmartAmp.music_bridge"}},
                {"index": 2, "sink": 3, "properties": {"application.name": "smartamp-selftest"}},
            ],
        }
        def listing(kind: str) -> list[dict[str, Any]]:
            return listings[kind]

        with mock.patch.object(session.runtime, "pactl_list", side_effect=listing):
            self.assertFalse(session.playing())
            self.assertTrue(session.bridge_present("music_bridge"))


class TierTests(unittest.TestCase):
    def make_session(self, **overrides: Any) -> Session:
        config = SelftestConfig.from_mapping({**OFFICE, **overrides})
        return Session(config, Runtime(config), Report("office-amp"), Options())

    def test_the_tiers_run_cheap_and_silent_before_audible(self) -> None:
        names = [tier.name for tier in TIERS]
        self.assertEqual(names[0], "services")
        self.assertLess(names.index("playback"), names.index("acoustic"))
        self.assertEqual(names[-1], "recovery")
        self.assertEqual([tier.name for tier in TIERS if tier.audible], ["acoustic"])

    def test_services_reads_the_units_and_the_controllers_connections(self) -> None:
        session = self.make_session()
        status: dict[str, Any] = {
            "sink": "alsa_output.hifiberry",
            "music_bus": {"sink": "smartamp_music"},
            "voice_bus": {"sink": "smartamp_voice"},
            "sources": {"sendspin": {}, "usb": {}},
        }
        journal = "connected to voice assistant\nconnected to Home Assistant\nopened Stream Deck +\n"
        def active(unit: str) -> bool:
            return unit != "smartamp-sendspin"

        with mock.patch.object(session.runtime, "unit_active", side_effect=active), \
                mock.patch.object(session, "status", return_value=status), \
                mock.patch.object(session, "inputs_status", return_value={"inputs": {}}), \
                mock.patch.object(session.runtime, "journal_since_start", return_value=journal), \
                mock.patch.object(session.runtime, "journal", return_value=""):
            services.run(session)
        outcomes = {check.name: check.outcome for check in session.report.checks}
        self.assertEqual(outcomes["smartamp-sendspin is active"], Outcome.FAIL)
        self.assertEqual(outcomes["smartamp-audio-manager is active"], Outcome.PASS)
        self.assertEqual(outcomes["the mixer knows every configured source"], Outcome.PASS)
        self.assertEqual(outcomes["controller reached the voice assistant"], Outcome.PASS)
        self.assertEqual(outcomes["controller holds the audio manager socket"], Outcome.PASS)

    def test_commands_checks_refusals_before_touching_a_playing_amp(self) -> None:
        session = self.make_session()
        replies: dict[str, dict[str, Any]] = {
            "get-state": {"event": "state", "music_bus": {}},
            "no-such-command": {"event": "error", "error": "unknown command"},
            "set-music-volume": {"event": "error", "error": "needs a percent"},
            "set-duck": {"event": "error", "error": "needs a boolean"},
        }
        def answer(name: str, /, **fields: Any) -> dict[str, Any]:
            return replies[name]

        with mock.patch.object(session.control, "command", side_effect=answer), \
                mock.patch.object(session, "playing", return_value=True):
            commands.run(session)
        outcomes = [check.outcome for check in session.report.checks]
        self.assertEqual(outcomes[:5], [Outcome.PASS] * 5)
        self.assertEqual(session.report.checks[-1].outcome, Outcome.SKIP)


class MainTests(unittest.TestCase):
    def test_the_entry_point_refuses_an_unknown_tier(self) -> None:
        from selftest.__main__ import main

        with tempfile.TemporaryDirectory() as base:
            config = Path(base) / "selftest.json"
            config.write_text(json.dumps(OFFICE), encoding="utf-8")
            with mock.patch("os.geteuid", return_value=0), \
                    self.assertRaises(SystemExit) as raised:
                main(["--config", str(config), "--only", "nowhere"])
            self.assertEqual(raised.exception.code, 2)

    def test_a_missing_socket_is_one_failed_check_not_a_crash(self) -> None:
        from selftest.__main__ import main

        with tempfile.TemporaryDirectory() as base:
            config = Path(base) / "selftest.json"
            config.write_text(json.dumps({**OFFICE, "socket": f"{base}/none.sock"}), encoding="utf-8")
            with mock.patch("os.geteuid", return_value=0), \
                    mock.patch("sys.stdout") as stdout:
                self.assertEqual(main(["--config", str(config), "--json"]), 1)
            printed = "".join(str(call.args[0]) for call in stdout.write.call_args_list)
            self.assertIn("audio manager socket", printed)



if __name__ == "__main__":
    unittest.main()
