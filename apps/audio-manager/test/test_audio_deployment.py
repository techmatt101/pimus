from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
ROLE = ROOT / "ansible/roles/smartamp"
FILES = ROLE / "files"


class AudioDeploymentTests(unittest.TestCase):
    def test_soft_mixer_rule_targets_the_platform_card_device(self) -> None:
        # api.alsa.soft-mixer is a device property: a rule matching the output
        # node instead is ignored without a word, and the hardware ceiling
        # silently stops holding.
        config = (FILES / "wireplumber/51-smartamp-soft-mixer.conf").read_text()
        self.assertIn("device.name", config)
        self.assertNotIn("node.name", config)
        strings = [
            json.loads(match[0]) for match in re.finditer(r'"(?:\\.|[^"\\])*"', config)
        ]
        pattern = next(value[1:] for value in strings if value.startswith("~alsa_card"))
        self.assertIsNotNone(re.fullmatch(pattern, "alsa_card.platform-soc_sound"))
        self.assertIsNone(re.fullmatch(pattern, "alsa_card.usb-XMOS_XVF3800-00"))
        self.assertIsNone(re.fullmatch(pattern, "alsa_cardXplatform-soc_sound"))
        lua = (FILES / "wireplumber/51-smartamp-soft-mixer.lua").read_text()
        self.assertIn('"device.name", "matches", "alsa_card.platform-*"', lua)
        self.assertNotIn("node.name", lua)

    def test_hardware_init_stops_at_each_failed_mixer_control(self) -> None:
        script = (FILES / "scripts/hifiberry-init.sh").read_text()
        script = script.replace("/usr/bin/aplay", "probe").replace(
            "/usr/bin/arecord", "probe"
        )
        script = script.replace("/usr/bin/amixer", "mixer").replace(
            "/usr/sbin/alsactl", "store"
        )
        harness = """
probe() { echo sndrpihifiberry; }
mixer() { printf '%s\n' "$5"; [ "$5" != "$FAIL_CONTROL" ]; }
store() { echo stored; return "$STORE_EXIT"; }
"""
        environment = {
            **os.environ,
            "HIFIBERRY_CARD_NAME": "sndrpihifiberry",
            "HIFIBERRY_AUX_INPUT_LEFT": "VINL1[SE]",
            "HIFIBERRY_AUX_INPUT_RIGHT": "VINR1[SE]",
            "HIFIBERRY_AUX_GAIN_DB": "0",
            "HIFIBERRY_OUTPUT_VOLUME_PERCENT": "90",
            "HIFIBERRY_HAS_AUX": "1",
            "STORE_EXIT": "0",
        }
        for control in ("ADC Left Input", "ADC Right Input", "ADC", "Digital"):
            with self.subTest(control=control):
                result = subprocess.run(
                    ["sh", "-c", harness + script],
                    env={**environment, "FAIL_CONTROL": control},
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout.splitlines()[-1], control)
                self.assertNotIn("stored", result.stdout)
        for has_aux in ("0", "1"):
            with self.subTest(has_aux=has_aux):
                result = subprocess.run(
                    ["sh", "-c", harness + script],
                    env={
                        **environment,
                        "FAIL_CONTROL": "",
                        "HIFIBERRY_HAS_AUX": has_aux,
                    },
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines()[-2:], ["Digital", "stored"])

    def test_manager_requires_successful_hardware_initialisation(self) -> None:
        service = (ROLE / "templates/smartamp-audio-manager.service.j2").read_text()
        requires = next(
            line for line in service.splitlines() if line.startswith("Requires=")
        )
        self.assertIn("smartamp-hifiberry.service", requires)
        self.assertIn(
            "smartamp-hifiberry.service",
            next(line for line in service.splitlines() if line.startswith("After=")),
        )

    def test_manager_keeps_no_state_on_disk(self) -> None:
        # Silence is a music level the controller re-asserts, not a saved mute,
        # so the daemon has nothing to remember across a restart.
        service = (ROLE / "templates/smartamp-audio-manager.service.j2").read_text()
        self.assertNotIn("StateDirectory", service)
        self.assertNotIn("--mute-state", service)

    def test_doctor_checks_every_digital_playback_channel(self) -> None:
        template = (ROLE / "templates/smartamp-doctor.sh.j2").read_text()
        start = template.index("if ! DIGITAL=")
        # The LEVELS page may move the ceiling from its boot value, so an even
        # reading elsewhere is a warning; uneven, unreadable, or below the
        # floor the manager would set is still a failure.
        end = template.index("{% if smartamp_hifiberry_caps.aux_input", start)
        script = template[start:end].replace(
            "{{ hifiberry_card_name | quote }}", "sndrpihifiberry"
        ).replace("{{ hifiberry_output_volume_percent | int }}", "90")
        harness = """
amixer() { printf '%s\\n' "$MIXER_OUTPUT"; return "$MIXER_EXIT"; }
pass() { printf 'PASS %s\\n' "$1"; }
warn() { printf 'WARN %s\\n' "$1"; }
fail() { printf 'FAIL %s\\n' "$1"; FAILED=1; }
FAILED=0
"""
        left = "  Front Left: Playback 186 [90%] [-10.50dB] [on]"
        right = "  Front Right: Playback 186 [90%] [-10.50dB] [on]"
        for output, mixer_exit, expected in (
            (left + "\n" + right, 0, 0),
            ("  Mono: Playback 186 [90%] [-10.50dB] [on]", 0, 0),
            ((left + "\n" + right).replace("[90%]", "[100%]"), 0, 0),
            ((left + "\n" + right).replace("[90%]", "[60%]"), 0, 1),
            (left + "\n" + right.replace("[90%]", "[100%]"), 0, 1),
            (left.replace("[90%]", "[80%]") + "\n" + right, 0, 1),
            (left + "\n" + right.replace("[90%]", "[unknown]"), 0, 1),
            ("", 0, 1),
            (left + "\n" + right, 1, 1),
        ):
            with self.subTest(output=output, mixer_exit=mixer_exit):
                result = subprocess.run(
                    ["sh", "-c", harness + script + '\nexit "$FAILED"\n'],
                    env={**os.environ, "MIXER_OUTPUT": output, "MIXER_EXIT": str(mixer_exit)},
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    @staticmethod
    def ready_status() -> dict[str, Any]:
        return {
            "sink": "hifi",
            "idle": False,
            "voice_bus": {"enabled": True, "sink": "voice", "available": True},
            "music_bus": {"sink": "background", "available": True},
            "aec_reference": {
                "sink": "xvf",
                "available": True,
                "endpoints_available": True,
            },
        }

    def test_voice_startup_waits_for_capture_and_accepts_intentionally_idle_bus(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "sleep").write_text("#!/bin/sh\nexit 0\n")
            (path / "sleep").chmod(0o755)
            # The capture side is read from PipeWire's source list, not the
            # status file: each line is an index, a name, and the rest.
            (path / "pactl").write_text(
                "#!/bin/sh\nprintf '%s\\n' $PACTL_SOURCES | awk '{ print NR, $0, \"x\" }'\n"
            )
            (path / "pactl").chmod(0o755)
            status_file = path / "status.json"
            wanted = ["smartamp_voice_input", "smartamp_voice_capture"]
            for scenario, expected in (
                ("ready", 0),
                ("missing_capture", 1),
                ("missing_input", 1),
                ("missing_bus", 1),
                ("unbridged", 1),
                ("idle", 0),
                ("unmapped", 0),
            ):
                with self.subTest(scenario=scenario):
                    status = self.ready_status()
                    sources = ["hifi.monitor", *wanted]
                    names = wanted
                    if scenario == "missing_capture":
                        sources.remove("smartamp_voice_capture")
                    elif scenario == "missing_input":
                        sources.remove("smartamp_voice_input")
                    elif scenario == "missing_bus":
                        status["voice_bus"]["sink"] = None
                    elif scenario in ("unbridged", "idle"):
                        status["voice_bus"]["available"] = False
                        status["idle"] = scenario == "idle"
                    elif scenario == "unmapped":
                        sources.remove("smartamp_voice_capture")
                        names = ["smartamp_voice_input"]
                    status_file.write_text(json.dumps(status))
                    result = subprocess.run(
                        [
                            "sh",
                            str(FILES / "scripts/wait-audio-ready.sh"),
                            str(status_file),
                            "1",
                            *names,
                        ],
                        env={
                            **os.environ,
                            "PATH": f"{path}:{os.environ['PATH']}",
                            "PACTL_SOURCES": " ".join(sources),
                        },
                        capture_output=True,
                        timeout=5,
                    )
                    self.assertEqual(result.returncode, expected, result.stderr)

    def test_doctor_distinguishes_idle_routes_from_missing_endpoints(self) -> None:
        template = (ROLE / "templates/smartamp-doctor.sh.j2").read_text()
        expressions = re.findall(r"jq -e '([^']+)' \"\$STATUS_FILE\"", template)
        for section in ("voice_bus", "music_bus", "aec_reference"):
            expression = next(
                value for value in expressions if f".{section}.available" in value
            )
            for scenario, expected in (
                ("ready", 0),
                ("missing_stream", 1),
                ("idle", 0),
                ("missing_endpoint", 1),
            ):
                with self.subTest(section=section, scenario=scenario):
                    status = self.ready_status()
                    if scenario != "ready":
                        status[section]["available"] = False
                    if scenario in ("idle", "missing_endpoint"):
                        status["idle"] = True
                    if scenario == "missing_endpoint":
                        status[section]["sink"] = None
                        status[section]["endpoints_available"] = False
                    result = subprocess.run(
                        ["jq", "-e", expression],
                        input=json.dumps(status),
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    self.assertEqual(result.returncode, expected, result.stderr)


class CaptureRecoveryTests(unittest.TestCase):
    def test_capture_thread_failure_exits_the_whole_process(self) -> None:
        for failure in (
            "raise SystemExit(1)",
            "raise RuntimeError('capture disconnected')",
        ):
            with self.subTest(failure=failure):
                program = f"""
import sys
import threading
sys.path.insert(0, {str(FILES)!r})
from smartamp_audio_recovery import exit_on_capture_failure
def capture():
    {failure}
thread = threading.Thread(target=exit_on_capture_failure(capture))
thread.start()
thread.join()
print("incorrectly still running")
"""
                result = subprocess.run(
                    [sys.executable, "-c", program],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertNotIn("incorrectly still running", result.stdout)
                self.assertIn("restarting voice assistant", result.stderr)

    def test_normal_completion_and_clean_exit_are_preserved(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "smartamp_audio_recovery", FILES / "smartamp_audio_recovery.py"
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def identity(value: int) -> int:
            return value

        self.assertEqual(module.exit_on_capture_failure(identity)(42), 42)

        def clean_exit():
            raise SystemExit(0)

        with self.assertRaises(SystemExit) as raised:
            module.exit_on_capture_failure(clean_exit)()
        self.assertEqual(raised.exception.code, 0)
