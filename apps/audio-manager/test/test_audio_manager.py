from __future__ import annotations

# These tests drive a few private daemon methods directly, standing where a
# selector callback or the shutdown path would.
# pyright: reportPrivateUsage=false

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
from typing import Any, Callable
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).parents[3] / "libs/audio-common/src"))


from smartamp_audio import graph, volume  # noqa: E402
from audio_manager.buses import voice_meter  # noqa: E402
from smartamp_audio import server as control_server  # noqa: E402
from smartamp_audio import (  # noqa: E402
    monitors,
    pactl,
    process,
)
from audio_manager.config import AudioConfig  # noqa: E402
from audio_manager.daemon import AudioManager  # noqa: E402
from audio_manager.idle import IdleTracker  # noqa: E402


Listings = dict[str, list[graph.Node]]


def listing(listings: Listings) -> Callable[[str], list[graph.Node]]:
    return lambda kind: listings.get(kind, [])


def completed(*args: str, returncode: int = 0, stdout: str = "") -> Any:
    return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr="")


def fake_run(*args: str, check: bool = True) -> Any:
    defaults = {"get-default-sink": "hifiberry"}
    stdout = next((name + "\n" for key, name in defaults.items() if key in args), "")
    return completed(*args, stdout=stdout)


def volume_writes(run: mock.Mock) -> list[tuple[str, str]]:
    return [
        (call.args[2], call.args[3])
        for call in run.call_args_list
        if "set-sink-input-volume" in call.args
    ]


class ManagerTestCase(unittest.TestCase):
    def make_manager(
        self, raw_config: dict[str, Any], *, state_path: Path | None = None
    ) -> AudioManager:
        base: dict[str, Any] = {"output_match": "HiFiBerry", "sources": {}}
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name)
        manager = AudioManager(
            AudioConfig.from_mapping({**base, **raw_config}),
            path / "control.sock",
            path / "status.json",
            state_path=state_path,
        )
        self.addCleanup(manager.selector.close)
        return manager

    @staticmethod
    @contextlib.contextmanager
    def _patched_graph(listings: Listings, run: Any) -> Any:
        """Answer every graph listing from a dict, and every command from run."""
        with mock.patch.object(
            pactl, "list_json", side_effect=listing(listings)
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
        assert selected is not None
        self.assertEqual(selected["name"], "alsa_input.usb-XVF3800")

    def test_device_match_searches_properties(self) -> None:
        nodes = [
            {
                "name": "source.1",
                "properties": {"device.product.name": "HiFiBerry DAC2 ADC Pro"},
            }
        ]
        selected = graph.find_node(nodes, "HiFiBerry")
        assert selected is not None
        self.assertEqual(selected["name"], "source.1")

    def test_owned_stream_matches_numeric_or_string_module_id(self) -> None:
        streams = [
            {"index": 10, "owner_module": 7},
            {"index": 11, "owner_module": "8"},
        ]
        owned = graph.find_owned_stream(streams, 8)
        assert owned is not None
        self.assertEqual(owned["index"], 11)
        self.assertIsNone(graph.find_owned_stream(streams, 9))

        tagged = [
            {"index": 12, "properties": {"media.name": "SmartAmp.music_bridge"}}
        ]
        tagged_stream = graph.find_owned_stream(tagged, 8, "SmartAmp.music_bridge")
        assert tagged_stream is not None
        self.assertEqual(tagged_stream["index"], 12)

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
        assert selected is not None
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
        assert selected is not None
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
            {"sources": {"aux": {"enabled": True}, "line_in": {"enabled": False}}}
        )
        self.assertEqual(manager.mixer.enabled, {"aux": True, "line_in": False})

    def test_route_commands_update_memory_state(self) -> None:
        manager = self._duckable_manager(aux={"enabled": True}, line_in={"enabled": False})
        connection = mock.Mock()

        with self._patched_graph({}, fake_run):
            reply, reconcile = manager.commands.apply(
                connection, {"command": "set-source-state", "name": "line_in", "state": "toggle"}
            )
        self.assertEqual(
            reply,
            {
                "event": "state",
                "sink": None,
                "output_volume": None,
                "music_bus": {
                    "available": False,
                    "sink": None,
                    "ducked": False,
                    "volume": 100,
                    "muted": False,
                },
                "voice_bus": {
                    "enabled": False,
                    "available": False,
                    "sink": None,
                    "volume": 100,
                },
                "aec_reference": {
                    "enabled": False,
                    "available": False,
                    "endpoints_available": False,
                    "sink": None,
                },
                "sources": {
                    "aux": {"trim": 100, "enabled": True, "available": False},
                    "line_in": {"trim": 100, "enabled": True, "available": False},
                },
                "idle": False,
            },
        )
        self.assertTrue(reconcile)

        # Re-applying the current state must not trigger graph work.
        _, reconcile = manager.commands.apply(
            connection, {"command": "set-source-state", "name": "line_in", "state": "on"}
        )
        self.assertFalse(reconcile)

        # A source with nothing to switch, or none at all, is not a route.
        for name in ("phono", "sendspin"):
            reply, reconcile = manager.commands.apply(
                connection, {"command": "set-source-state", "name": name, "state": "on"}
            )
            self.assertEqual(reply["event"], "error")
            self.assertFalse(reconcile)

    def test_trim_commands_are_refused_for_inputs_this_unit_does_not_have(self) -> None:
        manager = self.make_manager({"sources": {"aux": {"volume_percent": 90}}})
        # Only the sources inventory listed exist, whatever the bus's default
        # source is called.
        self.assertEqual(list(manager.sources()), ["aux"])
        self.assertEqual(manager.sources()["aux"]["trim"], 90)

        for message in (
            {"command": "set-source-trim", "name": "players", "percent": 50},
            {"command": "set-source-trim", "name": "aux", "percent": 120},
        ):
            reply, reconcile = manager.commands.apply(mock.Mock(), message)
            self.assertEqual(reply["event"], "error")
            self.assertFalse(reconcile)
        self.assertEqual(manager.sources()["aux"]["trim"], 90)

    def test_inventory_names_the_default_source(self) -> None:
        # Sendspin plays into the bus by its own unit's PULSE_SINK and carries
        # no tag; the untagged stream is the default source's, under the name
        # inventory gives it.
        manager = self.make_manager(
            {"music_bus": {"enabled": True, "sink_name": "background"},
             "default_source": "sendspin",
             "sources": {"sendspin": {"volume_percent": 70}}}
        )
        self.assertEqual(
            manager.sources(), {"sendspin": {"trim": 70, "available": False}}
        )
        bus: graph.Node = {"name": "background", "index": 2}
        stream: graph.Node = {
            "index": 81, "sink": 2, "properties": {"media.name": "ALSA Playback"},
            "volume": {"mono": {"value_percent": "100%"}},
        }
        with self._patched_graph({"sinks": [bus], "sink-inputs": [stream]}, fake_run) as run:
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-source-trim", "name": "sendspin", "percent": 55}
            )
        self.assertFalse(reconcile)
        self.assertEqual(reply["sources"]["sendspin"]["trim"], 55)
        self.assertEqual(volume_writes(run), [("81", "55%")])

    def test_socket_commands_reconcile_and_answer_with_live_state(self) -> None:
        manager = self._duckable_manager(aux={"enabled": False})
        manager.safe_reconcile = mock.Mock()
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        left.setblocking(False)
        manager.control.clients = {left: b""}
        manager.selector.register(left, selectors.EVENT_READ, lambda: None)

        right.sendall(b'{"command": "set-source-state", "name": "aux", "state": "on"}\n')
        with self._patched_graph({}, fake_run):
            manager.control.read(left)

        reply = json.loads(right.recv(4096))
        self.assertEqual(reply["event"], "state")
        self.assertEqual(reply["sources"]["aux"]["enabled"], True)
        self.assertEqual(reply["music_bus"]["volume"], 100)
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
        self.assertTrue(reply["music_bus"]["ducked"])
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
        # mid-conversation must not leave the music ducked.
        manager.control.drop(connection)
        self.assertFalse(manager.desired_ducking())

    def test_ducking_stays_off_when_the_music_bus_is_disabled(self) -> None:
        manager = self.make_manager({"music_bus": {"enabled": False}})
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

    def _duckable_manager(self, **sources: dict[str, Any]) -> AudioManager:
        return self.make_manager(
            {"music_bus": {"enabled": True, "ducking_enabled": True}, "sources": sources}
        )


class VoiceLevelTests(ManagerTestCase):
    def test_block_level_rises_with_amplitude_and_floors_at_silence(self) -> None:
        def block(amplitude: int) -> bytes:
            samples = array.array(
                "h", [amplitude if index % 2 else -amplitude for index in range(160)]
            )
            return samples.tobytes()

        self.assertEqual(voice_meter.block_level(block(0)), 0.0)
        loud = voice_meter.block_level(block(30000))
        quiet = voice_meter.block_level(block(600))
        self.assertGreater(loud, quiet)
        self.assertLessEqual(loud, 1.0)
        self.assertGreaterEqual(quiet, 0.0)
        # Anything under the floor is a pause between words, not quiet speech.
        self.assertEqual(voice_meter.block_level(block(20)), 0.0)

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
        captured: list[str] = []

        def capture(source: str) -> Any:
            captured.append(source)
            read_fd, write_fd = os.pipe()
            self.addCleanup(os.close, write_fd)
            running = mock.Mock(stdout=open(read_fd, "rb", buffering=0))
            running.poll.return_value = None
            return running

        selector = selectors.DefaultSelector()
        self.addCleanup(selector.close)
        meter = voice_meter.VoiceLevelMeter(
            selector, lambda _level: None, capture=capture, clock=lambda: clock
        )
        self.addCleanup(meter.close)

        meter.request(True)
        meter.tick()
        self.assertEqual(captured, [])

        meter.set_source("smartamp_voice.monitor")
        meter.tick()
        self.assertEqual(captured, ["smartamp_voice.monitor"])

        # Releasing holds the capture briefly, so the next reply in the same
        # conversation is not metered from a cold start.
        meter.request(False)
        meter.tick()
        self.assertEqual(meter.deadline(), 1000.0 + voice_meter.LINGER_SECONDS)


class SubscribeEventTests(unittest.TestCase):
    def test_subscribe_lines_filter_out_self_inflicted_noise(self) -> None:
        self.assertTrue(monitors.is_relevant_event("Event 'change' on sink #43"))
        self.assertTrue(monitors.is_relevant_event("Event 'remove' on module #7"))
        # pactl invocations from our own reconcile emit client events; reacting
        # to them would reconcile forever.
        self.assertFalse(monitors.is_relevant_event("Event 'new' on client #99"))
        self.assertFalse(monitors.is_relevant_event("garbage"))

    def test_a_level_this_process_wrote_echoes_without_a_reconcile(self) -> None:
        # Every level write comes straight back as a change event; a reconcile
        # on each one found nothing to do and cost a burst of listings.
        with mock.patch.object(process, "run", return_value=completed()), mock.patch(
            "smartamp_audio.pactl.time.monotonic", return_value=100.0
        ):
            pactl.set_sink_input_volume(42, 55)
        self.assertTrue(monitors.is_level_echo("Event 'change' on sink-input #42", now=100.1))
        self.assertTrue(monitors.is_level_echo("Event 'change' on sink #3", now=100.1))
        # A stream arriving or leaving is never an echo, whatever was just written.
        self.assertFalse(monitors.is_level_echo("Event 'new' on sink-input #43", now=100.1))
        self.assertFalse(monitors.is_level_echo("Event 'remove' on sink-input #42", now=100.1))
        # Nor is a change from anyone else once the write's own has had time to land.
        self.assertFalse(monitors.is_level_echo("Event 'change' on sink #3", now=100.5))

    def test_a_streams_own_change_is_told_apart_from_its_arrival(self) -> None:
        self.assertTrue(monitors.is_stream_change("Event 'change' on sink-input #42"))
        self.assertFalse(monitors.is_stream_change("Event 'new' on sink-input #42"))
        self.assertFalse(monitors.is_stream_change("Event 'change' on sink #3"))




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




    def test_a_switchable_source_is_held_silent_and_toggles_by_fading(self) -> None:
        manager = self.make_manager(
            {
                "music_bus": {"enabled": True, "sink_name": "background"},
                "sources": {"aux": {"enabled": False}},
            }
        )
        bus: graph.Node = {"name": "background", "index": 2}
        stream: graph.Node = {
            "index": 61, "sink": 2, "properties": {"smartamp.source": "aux"}
        }
        listings: Listings = {"sinks": [bus], "sink-inputs": [stream]}

        def run(*args: str, check: bool = True) -> Any:
            if "set-sink-input-volume" in args:
                stream["volume"] = {"mono": {"value_percent": args[-1]}}
            return fake_run(*args, check=check)

        def writes(action: Callable[[], object]) -> list[str]:
            with self._patched_graph(listings, run) as run_mock, mock.patch(
                "smartamp_audio.volume.time.sleep"
            ):
                manager.graph.invalidate()
                action()
            return [
                call.args[-1]
                for call in run_mock.call_args_list
                if "set-sink-input-volume" in call.args
            ]

        def reconcile() -> list[str]:
            return writes(lambda: manager.mixer.reconcile(bus))

        # Off at boot: the input's loopback is born silent, and the mixer
        # holds it there rather than letting it play a syllable at full level.
        self.assertEqual(reconcile(), ["0%"])

        # Turning the source on is a fade up to its trim, not a rebuild.
        volumes = writes(lambda: manager.set_source_enabled("aux", True))
        self.assertGreater(len(volumes), 1)
        self.assertEqual(volumes[-1], "100%")
        self.assertTrue(manager.sources()["aux"]["enabled"])

        volumes = writes(lambda: manager.set_source_enabled("aux", False))
        self.assertEqual(volumes[-1], "0%")

        # A settled toggle writes nothing on the next pass.
        self.assertEqual(reconcile(), [])

        # Live drift is repaired even when the desired toggle did not change.
        stream["volume"] = {"mono": {"value_percent": "25%"}}
        self.assertEqual(reconcile(), ["0%"])

        # A recreated stream comes back at full volume; the replacement must
        # be recognised and snapped silent too.
        stream.update(index=62, volume={"mono": {"value_percent": "100%"}})
        self.assertEqual(reconcile(), ["0%"])
        self.assertEqual(stream["volume"], {"mono": {"value_percent": "0%"}})

    def test_aec_reference_bridges_output_monitor_into_the_xvf3800(self) -> None:
        manager = self.make_manager(
            {
                "echo_reference": {
                    "enabled": True,
                    "sink_match": "XVF3800",
                    "latency_ms": 40,
                },
            }
        )
        loaded: list[tuple[str, tuple[str, ...]]] = []
        listings: Listings = {
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
        ), mock.patch("smartamp_audio.status.write") as status_write:
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
            {"enabled": True, "available": True, "endpoints_available": True, "sink": "xvf_playback"},
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
                "echo_reference": {
                    "enabled": True,
                    "sink_match": "XVF3800",
                    "latency_ms": 40,
                },
            }
        )
        manager.modules.adopt("_aec", 30, ("hifiberry.monitor", "xvf_playback"))
        listings: Listings = {
            "sinks": [{"name": "hifiberry", "description": "HiFiBerry DAC2 ADC Pro"}],
            "sources": [{"name": "hifiberry.monitor", "monitor_of_sink": 0}],
            "sink-inputs": [],
            "cards": [],
            "modules": [{"index": 30}],
        }

        with self._patched_graph(listings, fake_run) as run, mock.patch(
            "smartamp_audio.status.write"
        ) as status_write:
            manager.reconcile()

        self.assertNotIn("_aec", manager.modules)
        self.assertIn(
            ("pactl", "unload-module", "30"), [call.args for call in run.call_args_list]
        )
        status = status_write.call_args.args[1]
        self.assertEqual(
            status["aec_reference"],
            {"enabled": True, "available": False, "endpoints_available": False, "sink": None},
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
                "echo_reference": {
                    "enabled": True,
                    "sink_match": "XVF3800",
                    "latency_ms": 40,
                },
                "music_bus": {
                    "enabled": True,
                    "sink_name": "background",
                    "latency_ms": 40,
                },
                "sources": {"aux": {"enabled": False}},
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
            ), mock.patch(
                "smartamp_audio.volume.time.sleep"
            ), mock.patch(
                "smartamp_audio.status.write"
            ) as status_write:
                manager.reconcile()
            return status_write.call_args.args[1]

        # Something is playing: the sink, its bridge, and the AEC reference
        # all come up.
        status = reconcile()
        self.assertFalse(status["idle"])
        for role in ("_music_sink", "_music_bridge", "_aec"):
            self.assertIn(role, manager.modules)

        # The stream ends. Inside the timeout everything stays loaded — the
        # daemon's own bridge streams must not count as activity.
        listings["sink-inputs"] = [
            stream for stream in listings["sink-inputs"] if stream is not playing
        ]
        clock["now"] = 30.0
        status = reconcile()
        self.assertFalse(status["idle"])
        self.assertIn("_music_bridge", manager.modules)

        # Past the timeout the bridges are released; the null sink stays so
        # clients pointed at it by PULSE_SINK keep their target. Nothing is
        # playing, so the teardown needs no protective mute.
        clock["now"] = 90.0
        before_teardown = len(commands)
        status = reconcile()
        self.assertTrue(status["idle"])
        for role in ("_music_bridge", "_aec"):
            self.assertNotIn(role, manager.modules)
        self.assertIn("_music_sink", manager.modules)
        self.assertIsNone(manager.idle.deadline())
        self.assertNotIn(
            "set-sink-mute", {arg for args in commands[before_teardown:] for arg in args}
        )

        # A client starts playing again: everything rebuilds on the next pass,
        # behind a mute held on the output sink, and the fresh bridge is faded
        # in only once that mute has lifted, so the music arrives as a ramp
        # rather than a step.
        listings["sink-inputs"].append(playing)
        clock["now"] = 100.0
        before_rebuild = len(commands)
        status = reconcile()
        self.assertFalse(status["idle"])
        for role in ("_music_bridge", "_aec"):
            self.assertIn(role, manager.modules)
        rebuild = commands[before_rebuild:]
        muted = rebuild.index(("pactl", "set-sink-mute", "hifiberry", "1"))
        unmuted = rebuild.index(("pactl", "set-sink-mute", "hifiberry", "0"))
        self.assertLess(muted, unmuted)
        fade = rebuild[unmuted + 1 :]
        self.assertGreater(len(fade), 1)
        self.assertTrue(all(call[1] == "set-sink-input-volume" for call in fade))

    def test_a_voice_session_wakes_an_idle_graph_immediately(self) -> None:
        manager = self.make_manager(
            {"idle_teardown_seconds": 60, "music_bus": {"enabled": True}}
        )
        manager.idle.idle = True
        self.assertIsNone(manager.pending_reconcile)

        # The duck request arrives seconds before the first TTS stream exists,
        # so it must start the rebuild rather than wait for audio to appear.
        manager.commands.apply(mock.Mock(), {"command": "set-duck", "active": True})
        self.assertIsNotNone(manager.pending_reconcile)

    def test_a_forced_idle_skips_the_silence_timeout(self) -> None:
        manager = self.make_manager(
            {"idle_teardown_seconds": 60, "music_bus": {"enabled": True}}
        )
        self.assertFalse(manager.idle.update(False))

        # Forcing it releases on the next pass instead of waiting out the
        # timeout, so the idle state can be looked at without the wait.
        manager.commands.apply(mock.Mock(), {"command": "force-idle"})
        self.assertIsNotNone(manager.pending_reconcile)
        self.assertTrue(manager.idle.update(False))

        # Something playing wins, and the request is forgotten rather than
        # held: the next quiet spell waits out the timeout again.
        manager.commands.apply(mock.Mock(), {"command": "force-idle"})
        self.assertFalse(manager.idle.update(True))
        self.assertFalse(manager.idle.update(False))

        # With the teardown switched off there is nothing to force.
        disabled = self.make_manager({"music_bus": {"enabled": True}})
        disabled.commands.apply(mock.Mock(), {"command": "force-idle"})
        self.assertFalse(disabled.idle.update(False))

    def test_teardown_stays_off_by_default(self) -> None:
        manager = self.make_manager({})
        self.assertFalse(manager.idle.enabled)
        self.assertFalse(manager.idle.update(False))
        self.assertIsNone(manager.idle.deadline())


class VolumeTests(ManagerTestCase):
    def test_output_sink_is_pinned_to_full_scale(self) -> None:
        manager = self.make_manager({})
        with mock.patch.object(process, "run") as run, mock.patch.object(
            manager.graph, "find_sink", return_value=None
        ):
            manager.output.prepare()
            run.assert_not_called()

        # WirePlumber restored an old dial level: pin it back to 100, muted
        # while the level jumps.
        sink = {"name": "hifi", "volume": {"mono": {"value_percent": "20%"}}}
        with mock.patch.object(process, "run") as run, mock.patch.object(
            manager.graph, "find_sink", return_value=sink
        ):
            manager.output.prepare()
            self.assertEqual(
                [call.args for call in run.call_args_list],
                [
                    ("pactl", "set-sink-mute", "hifi", "1"),
                    ("pactl", "set-sink-volume", "hifi", "100%"),
                ],
            )

        # An already pinned sink writes nothing once the guard has let go, so
        # the pin can never echo itself into another reconcile.
        sink["volume"] = {"mono": {"value_percent": "100%"}}
        with mock.patch.object(process, "run") as run:
            manager.output.settle(True)
            run.assert_called_once_with("pactl", "set-sink-mute", "hifi", "0")
        with mock.patch.object(process, "run") as run, mock.patch.object(
            manager.graph, "find_sink", return_value=sink
        ):
            manager.output.prepare()
            manager.output.settle(True)
            run.assert_not_called()

    def test_output_sink_mute_belongs_to_the_daemon(self) -> None:
        manager = self.make_manager({"sources": {}})
        sink = {"name": "hifi", "mute": False, "volume": {"mono": {"value_percent": "100%"}}}
        with mock.patch.object(process, "run") as run, mock.patch.object(
            manager.graph, "find_sink", return_value=sink
        ):
            manager.output.prepare()
            manager.output.settle(True)
        self.assertEqual(
            [call.args for call in run.call_args_list],
            [("pactl", "set-sink-mute", "hifi", "1"), ("pactl", "set-sink-mute", "hifi", "0")],
        )

        # There is no user mute to keep: a mute WirePlumber restored or another
        # client left is undone, so sound always comes back after a rebuild.
        sink["mute"] = True
        with mock.patch.object(process, "run") as run, mock.patch.object(
            manager.graph, "find_sink", return_value=sink
        ):
            manager.output.prepare()
            manager.output.settle(True)
            run.assert_called_once_with("pactl", "set-sink-mute", "hifi", "0")

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

    def test_music_bridge_fades_without_changing_client_volumes(self) -> None:
        manager = self.make_manager(
            {"music_bus": {"enabled": True, "duck_volume_percent": 15, "fade_ms": 100}}
        )
        manager.music_bus.stream_index = 42
        manager.music_bus.ducked = False
        manager.music_bus.gain_applied = 100

        with mock.patch.object(process, "run") as run, mock.patch(
            "smartamp_audio.volume.time.sleep"
        ):
            manager.music_bus.apply_ducking(manager.music_volume, True)

        self.assertEqual([call.args[-1] for call in run.call_args_list], ["58%", "15%"])
        self.assertTrue(manager.music_bus.ducked)

    def test_vol_mute_silences_every_music_path_and_nothing_else(self) -> None:
        manager = self.make_manager(
            {
                "music_bus": {
                    "enabled": True,
                    "ducking_enabled": True,
                    "duck_volume_percent": 15,
                },
                "voice_bus": {"enabled": True, "volume_percent": 50},
            }
        )
        manager.music_volume = 60
        manager.music_bus.stream_index = 42
        manager.music_bus.ducked = False
        manager.music_bus.gain_applied = 60
        manager.voice_bus.stream_index = 43
        manager.voice_bus.gain_applied = 50
        client = {"index": 7, "sink": 1, "properties": {"media.name": "mpv"}}
        listings: Listings = {
            "sinks": [{"name": "hifi", "index": 1, "description": "HiFiBerry"}],
            "sink-inputs": [client],
        }

        def gains(action: Any) -> list[tuple[str, str]]:
            with self._patched_graph(listings, fake_run) as run:
                action()
            return volume_writes(run)

        # Muting drops the music bus and the direct client to silence;
        # the voice bus is not written at all, and the music level itself is
        # untouched.
        writes = gains(
            lambda: manager.commands.apply(
                mock.Mock(), {"command": "set-music-mute", "muted": True}
            )
        )
        self.assertIn(("42", "0%"), writes)
        self.assertIn(("7", "0%"), writes)
        self.assertNotIn("43", [stream for stream, _ in writes])
        self.assertTrue(manager.vol_muted)
        self.assertEqual(manager.music_volume, 60)
        self.assertEqual(manager.music_level, 0)
        self.assertTrue(manager.state_event()["music_bus"]["muted"])

        # Ducking a muted amp stays silent, and unmuting lands back on the
        # dial's level, ducked or not.
        gains(
            lambda: manager.commands.apply(
                mock.Mock(), {"command": "set-duck", "active": True}
            )
        )
        self.assertEqual(manager.music_bus.target_gain(manager.music_level, True), 0)
        writes = gains(
            lambda: manager.commands.apply(
                mock.Mock(), {"command": "set-music-mute", "muted": False}
            )
        )
        self.assertIn(("42", "9%"), writes)
        self.assertIn(("7", "60%"), writes)
        self.assertFalse(manager.vol_muted)

        reply, _ = manager.commands.apply(
            mock.Mock(), {"command": "set-music-mute", "muted": "yes"}
        )
        self.assertEqual(reply["event"], "error")

    def test_ducked_music_dips_by_the_duck_share_of_the_music_level(self) -> None:
        manager = self.make_manager(
            {"music_bus": {"enabled": True, "duck_volume_percent": 15}}
        )
        manager.music_volume = 60
        self.assertEqual(manager.music_bus.target_gain(60, False), 60)
        self.assertEqual(manager.music_bus.target_gain(60, True), 9)

    def test_voice_volume_command_applies_the_bridge_gain(self) -> None:
        manager = self.make_manager({"voice_bus": {"enabled": True}})
        manager.voice_bus.stream_index = 33

        with mock.patch.object(process, "run") as run:
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-voice-volume", "percent": 40}
            )

        self.assertEqual(reply["voice_bus"]["volume"], 40)
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

    def test_output_ceiling_command_writes_the_card_and_reads_it_back(self) -> None:
        manager = self.make_manager(
            {"output_ceiling": {"card": "sndrpihifiberry", "control": "Digital"}}
        )
        calls: list[tuple[str, ...]] = []

        def run(*args: str, check: bool = True) -> Any:
            calls.append(args)
            stdout = ""
            if args[:2] == ("amixer", "-c"):
                stdout = "  Front Left: Playback 207 [100%] [0.00dB] [on]\n"
            return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

        with mock.patch.object(process, "run", side_effect=run):
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-output-ceiling", "percent": 100}
            )

        # A hardware control under every graph gain: nothing to reconcile, and
        # the reply reports what the card took rather than what was asked.
        self.assertFalse(reconcile)
        self.assertEqual(reply["output_volume"], 100)
        self.assertEqual(
            calls,
            [
                ("amixer", "-q", "-c", "sndrpihifiberry", "sset", "Digital", "100%"),
                ("amixer", "-c", "sndrpihifiberry", "sget", "Digital"),
            ],
        )

    def test_output_ceiling_refuses_a_level_that_would_silence_the_amp(self) -> None:
        manager = self.make_manager(
            {"output_ceiling": {"card": "sndrpihifiberry", "control": "Digital"}}
        )
        with mock.patch.object(process, "run") as run:
            for percent in (69, 0, "90", True, 101, None):
                reply, _ = manager.commands.apply(
                    mock.Mock(), {"command": "set-output-ceiling", "percent": percent}
                )
                self.assertEqual(reply["event"], "error")
        run.assert_not_called()

        # A unit whose mixer the manager cannot read has no ceiling to move.
        unreadable = self.make_manager({})
        reply, _ = unreadable.commands.apply(
            mock.Mock(), {"command": "set-output-ceiling", "percent": 90}
        )
        self.assertEqual(reply["event"], "error")

    def test_music_volume_command_moves_the_bus_and_not_its_sources(self) -> None:
        manager = self.make_manager(
            {
                "music_bus": {
                    "enabled": True,
                    "sink_name": "background",
                    "duck_volume_percent": 15,
                    "fade_ms": 0,
                },
                "sources": {"aux": {"enabled": True}},
            }
        )
        manager.music_bus.stream_index = 42
        manager.music_bus.ducked = False
        manager.music_bus.gain_applied = 100
        listings: Listings = {
            "sinks": [{"name": "background", "index": 2}],
            "sink-inputs": [
                {
                    "index": 61,
                    "sink": 2,
                    "properties": {"smartamp.source": "aux"},
                    "volume": {"mono": {"value_percent": "100%"}},
                }
            ],
        }

        with self._patched_graph(listings, fake_run) as run, mock.patch(
            "smartamp_audio.volume.time.sleep"
        ):
            reply, reconcile = manager.commands.apply(
                mock.Mock(), {"command": "set-music-volume", "percent": 30}
            )

        self.assertEqual(reply["music_bus"]["volume"], 30)
        self.assertFalse(reconcile)
        # The music bus snaps to the new level. The aux stream carries only
        # its trim, because the bus bridge already carries the music level.
        self.assertEqual(volume_writes(run), [("42", "30%")])

    def test_each_music_input_carries_its_own_trim(self) -> None:
        manager = self.make_manager(
            {
                "music_bus": {"enabled": True, "sink_name": "background"},
                "default_source": "sendspin",
                "sources": {
                    "sendspin": {"volume_percent": 70},
                    "aux": {"enabled": True, "volume_percent": 50},
                    "usb": {"enabled": False, "volume_percent": 80},
                },
            }
        )
        music_sink: graph.Node = {"name": "background", "index": 2}
        full = {"mono": {"value_percent": "100%"}}
        listings: Listings = {
            "sinks": [{"name": "hifiberry", "index": 1}, music_sink],
            "sink-inputs": [
                # The inputs app's loopbacks, each tagged with its source.
                {"index": 61, "sink": 2, "properties": {"smartamp.source": "aux"}, "volume": full},
                {"index": 71, "sink": 2, "properties": {"smartamp.source": "usb"}, "volume": full},
                # Sendspin's own client stream into the bus: untagged, so the
                # default source's.
                {"index": 81, "sink": 2, "properties": {"media.name": "ALSA Playback"}, "volume": full},
                # A stream at the hardware sink is not the mixer's.
                {"index": 91, "sink": 1, "volume": full},
                # A tag this unit does not know is left alone.
                {"index": 95, "sink": 2, "properties": {"smartamp.source": "phono"}, "volume": full},
                # The bus's own bridge is never a source.
                {"index": 99, "sink": 2, "properties": {"media.name": "SmartAmp.music_bridge"}, "volume": full},
            ],
        }

        with self._patched_graph(listings, fake_run) as run:
            manager.graph.invalidate()
            manager.mixer.reconcile(music_sink)

        # Each stream carries only its source's trim - the shared bus bridge
        # carries the music level - and a switched-off source is held silent.
        self.assertEqual(
            volume_writes(run), [("81", "70%"), ("61", "50%"), ("71", "0%")]
        )
        self.assertEqual(
            manager.sources(),
            {
                "sendspin": {"trim": 70, "available": True},
                "aux": {"trim": 50, "enabled": True, "available": True},
                "usb": {"trim": 80, "enabled": False, "available": True},
            },
        )

    def test_percent_validation_rejects_booleans_and_out_of_range(self) -> None:
        self.assertTrue(volume.is_percent(0))
        self.assertTrue(volume.is_percent(100))
        self.assertFalse(volume.is_percent(True))
        self.assertFalse(volume.is_percent("50"))
        self.assertFalse(volume.is_percent(101))


class BusTests(ManagerTestCase):
    def test_voice_bus_is_bridged_and_a_new_stream_is_faded_in_to_the_gain(self) -> None:
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
        listings: Listings = {
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
            pactl, "list_json", side_effect=listing(listings)
        ), mock.patch.object(pactl, "list_modules", return_value=[]), mock.patch.object(
            pactl, "load_module", side_effect=load_module
        ), mock.patch.object(process, "run") as run, mock.patch(
            "smartamp_audio.volume.time.sleep"
        ):
            selected = manager.voice_bus.reconcile(output_sink)
            manager.voice_bus.apply_gain(manager.voice_volume)
            # A fresh stream is born silent; one that came up loud anyway is
            # held at nothing until the output is unguarded and it can fade in.
            run.assert_called_once_with("pactl", "set-sink-input-volume", "27", "0%")
            manager.voice_bus.fade_in()

        self.assertEqual(selected, voice)
        self.assertEqual(manager.voice_bus.stream_index, 27)
        # The existing sink is adopted by its owner module, so only the bridge
        # is loaded, and its stream asked to start silent.
        self.assertEqual(loaded[0][0], "module-loopback")
        self.assertTrue(
            loaded[0][1][-1].startswith(
                'sink_input_properties="media.name=SmartAmp.voice_bridge '
            )
        )
        self.assertIn("channelVolumes = [ 0.0 0.0 ]", loaded[0][1][-1])
        levels = [call.args[3] for call in run.call_args_list[1:]]
        self.assertEqual(levels[-1], "40%")
        self.assertEqual(levels, sorted(levels, key=lambda level: int(level[:-1])))
        self.assertGreater(len(levels), 1)
        listings["sink-inputs"][0]["volume"] = {
            "mono": {"value_percent": "40%"}
        }

        # A settled bus writes nothing on the next pass.
        with mock.patch.object(
            pactl, "list_json", side_effect=listing(listings)
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
            pactl, "list_json", side_effect=listing(listings)
        ), mock.patch.object(pactl, "list_modules", return_value=[]), mock.patch.object(
            process, "run"
        ) as run:
            manager.voice_bus.reconcile(output_sink)
            manager.voice_bus.apply_gain(manager.voice_volume)
        run.assert_called_once_with(
            "pactl", "set-sink-input-volume", "27", "40%"
        )

    def test_music_sink_is_created_and_its_bridge_is_identifiable(self) -> None:
        manager = self.make_manager(
            {
                "music_bus": {
                    "enabled": True,
                    "sink_name": "background",
                    "latency_ms": 40,
                }
            }
        )
        output_sink: graph.Node = {"name": "hifiberry"}
        background: graph.Node = {"name": "background", "owner_module": 10}
        listings: Listings = {
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
            pactl, "list_json", side_effect=listing(listings)
        ), mock.patch.object(pactl, "list_modules", return_value=[]), mock.patch.object(
            pactl, "load_module", side_effect=load_module
        ), mock.patch.object(process, "run"):
            selected = manager.music_bus.reconcile(output_sink)

        self.assertEqual(selected, background)
        self.assertEqual(manager.music_bus.stream_index, 21)
        self.assertEqual(loaded[0][0], "module-null-sink")
        self.assertIn("priority.session=1", loaded[0][1][-1])
        self.assertEqual(loaded[1][0], "module-loopback")
        self.assertTrue(
            loaded[1][1][-1].startswith(
                'sink_input_properties="media.name=SmartAmp.music_bridge '
            )
        )
        self.assertIn("channelVolumes = [ 0.0 0.0 ]", loaded[1][1][-1])


if __name__ == "__main__":
    unittest.main()
