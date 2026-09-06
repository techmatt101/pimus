"""State transitions across routing, client connections, and failed I/O."""

from __future__ import annotations

# These tests drive a few private daemon methods directly, standing where a
# selector callback or the shutdown path would.
# pyright: reportPrivateUsage=false

import json
import selectors
import socket
from typing import Any
from unittest import mock

from test_audio_manager import Listings, ManagerTestCase, fake_run, volume_writes
from smartamp_audio import graph
from audio_manager.daemon import AudioManager
from smartamp_audio import pactl


class RouteStateTests(ManagerTestCase):
    def test_music_bus_route_obeys_off_toggle_and_keeps_only_its_own_trim(self) -> None:
        manager = self.make_manager(
            {"sources": {"aux": {
                "match": "ADC",
                "target": "music",
                "mute_when_off": True,
                "volume_percent": 50,
            }}}
        )
        stream: graph.Node = {"index": 61, "owner_module": 60}
        listings: Listings = {
            "sources": [{"name": "ADC"}],
            "sink-inputs": [stream],
        }
        manager.modules.adopt("aux", 60)

        def run(*args: str, check: bool = True) -> Any:
            if "set-sink-input-volume" in args:
                stream["volume"] = {"mono": {"value_percent": args[-1]}}
            return fake_run(*args, check=check)

        def reconcile() -> dict[str, dict[str, Any]]:
            manager.graph.invalidate()
            manager.routes.reconcile(
                output={"name": "hifi"},
                music_sink={"name": "background"},
                music_volume=40,
            )
            return manager.routes.status()

        with self._patched_graph(listings, run) as commands, mock.patch(
            "smartamp_audio.volume.time.sleep"
        ):
            self.assertFalse(reconcile()["aux"]["enabled"])
            self.assertEqual(volume_writes(commands), [("61", "0%")])
            manager.routes.set_enabled("aux", True)
            reconcile()
            self.assertEqual(volume_writes(commands)[-1], ("61", "50%"))
            manager.routes.set_enabled("aux", False)
            reconcile()
            self.assertEqual(volume_writes(commands)[-1], ("61", "0%"))
            commands.reset_mock()
            reconcile()
            self.assertEqual(volume_writes(commands), [])
            stream.update(index=62, volume={"mono": {"value_percent": "100%"}})
            reconcile()
            self.assertEqual(volume_writes(commands), [("62", "0%")])
            # The trim moves live to balance this input against the others,
            # and a music-bus route carries it on its own stream whatever the
            # music level is doing.
            manager.routes.set_enabled("aux", True)
            reconcile()
            commands.reset_mock()
            manager.set_source_trim("aux", 80)
            self.assertEqual(volume_writes(commands)[-1], ("62", "80%"))
            self.assertEqual(manager.sources()["aux"]["trim"], 80)

    def test_failed_route_fade_can_be_reversed_and_retried(self) -> None:
        manager = self.make_manager(
            {"sources": {"aux": {"match": "ADC", "mute_when_off": True}}}
        )
        stream = {"index": 61, "owner_module": 60}
        manager.modules.adopt("aux", 60)
        with self._patched_graph({"sink-inputs": [stream]}, fake_run), mock.patch(
            "smartamp_audio.volume.time.sleep"
        ), mock.patch.object(pactl, "set_sink_input_volume") as write:
            manager.routes.apply_music_volume(40)
            manager.routes.set_enabled("aux", True)
            write.side_effect = [None, OSError("stream disappeared")]
            with self.assertRaises(OSError):
                manager.routes.apply_music_volume(40)
            manager.routes.set_enabled("aux", False)
            write.side_effect = None
            write.reset_mock()
            manager.routes.apply_music_volume(40)
            write.assert_called_once_with(61, 0)
            manager.routes.set_enabled("aux", True)
            manager.routes.apply_music_volume(40)
            self.assertEqual(write.call_args, mock.call(61, 40))


class StateBroadcastTests(ManagerTestCase):
    def test_clients_receive_voice_and_duck_changes_and_disconnect(self) -> None:
        manager = self.make_manager(
            {"music_bus": {"enabled": True, "ducking_enabled": True}}
        )
        sender, _ = self._client(manager)
        _, listener = self._client(manager)
        for command, section, field, expected in (
            ({"command": "set-voice-volume", "percent": 35}, "voice_bus", "volume", 35),
            ({"command": "set-duck", "active": True}, "music_bus", "ducked", True),
        ):
            manager.control._handle(sender, json.dumps(command).encode())
            manager._broadcast_changes()
            self.assertEqual(json.loads(listener.recv(4096))[section][field], expected)
        manager.control.drop(sender)
        manager._broadcast_changes()
        self.assertFalse(json.loads(listener.recv(4096))["music_bus"]["ducked"])

    def test_broadcast_detects_route_mutations_and_ignores_unchanged_state(self) -> None:
        manager = self.make_manager({"sources": {"aux": {}}})
        with mock.patch.object(manager.control, "broadcast") as broadcast:
            manager._broadcast_changes()
            broadcast.assert_not_called()
            manager.routes.set_enabled("aux", True)
            manager._broadcast_changes()
            broadcast.assert_called_once()
            self.assertTrue(broadcast.call_args.args[0]["sources"]["aux"]["enabled"])
            manager._broadcast_changes()
            broadcast.assert_called_once()

    def _client(self, manager: AudioManager) -> tuple[socket.socket, socket.socket]:
        connection, client = socket.socketpair()
        self.addCleanup(connection.close)
        self.addCleanup(client.close)
        client.settimeout(0.1)
        manager.control.clients[connection] = b""
        manager.selector.register(connection, selectors.EVENT_READ, lambda: None)
        return connection, client


class GainRecoveryTests(ManagerTestCase):
    def test_reversing_a_partially_failed_duck_restores_the_requested_gain(self) -> None:
        manager = self.make_manager({"music_bus": {"enabled": True, "fade_ms": 100}})
        manager.music_bus.stream_index = 42
        with mock.patch.object(pactl, "set_sink_input_volume") as write, mock.patch(
            "smartamp_audio.volume.time.sleep"
        ):
            manager.music_bus.apply_ducking(100, False)
            write.side_effect = [None, OSError("write failed mid-fade")]
            with self.assertRaises(OSError):
                manager.music_bus.apply_ducking(100, True)
            write.side_effect = None
            write.reset_mock()
            manager.music_bus.apply_ducking(100, False)
            write.assert_called_once_with(42, 100)


class MusicRegisterTests(ManagerTestCase):
    """The music bus sink's volume as the level's public face.

    Every music player reads and writes this one control, so the room keeps one
    loudness however it was set: a player that moves it moves the amp, and the
    amp writes it back so the next player to look agrees.
    """

    def _sink(self, percent: int, muted: bool = False) -> graph.Node:
        return {
            "name": "background",
            "index": 1,
            "volume": {"mono": {"value_percent": f"{percent}%"}},
            "mute": muted,
        }

    def test_the_register_carries_the_level_both_ways(self) -> None:
        manager = self.make_manager({"music_bus": {"enabled": True}})
        manager.music_volume = 40
        sink = self._sink(100)
        with self._patched_graph({"sinks": [sink]}, fake_run) as commands:
            # Nothing has agreed yet, so the amp seeds the register with the
            # level it already holds rather than adopting whatever it reads.
            manager._sync_music_register(sink)
            self.assertEqual(manager.music_volume, 40)
            self.assertIn(
                ("pactl", "set-sink-volume", "background", "40%"),
                [call.args for call in commands.call_args_list],
            )

            # A player moving the register is the room's new level.
            moved = self._sink(75)
            manager.graph.invalidate()
            with mock.patch.object(
                manager.graph, "sink_named", return_value=moved
            ):
                manager._sync_music_register(moved)
            self.assertEqual(manager.music_volume, 75)

    def test_an_agreed_register_is_left_alone(self) -> None:
        manager = self.make_manager({"music_bus": {"enabled": True}})
        manager.music_volume = 40
        sink = self._sink(40)
        with self._patched_graph({"sinks": [sink]}, fake_run) as commands:
            manager._sync_music_register(sink)
            commands.reset_mock()
            # Writing an unchanged register every pass would emit a subscribe
            # event that schedules the pass that writes it again.
            manager._sync_music_register(sink)
            self.assertEqual(commands.call_args_list, [])
            self.assertEqual(manager.music_volume, 40)


class ManagerLifecycleTests(ManagerTestCase):
    def test_stop_while_waiting_for_pulse_does_not_start_services(self) -> None:
        manager = self.make_manager({})
        connection = mock.Mock()
        manager.control.clients[connection] = b""
        manager.commands.apply(
            connection, {"command": "set-voice-meter", "active": True}
        )
        with mock.patch.object(
            manager, "wait_for_pulse", side_effect=manager.stop
        ), mock.patch.object(
            manager.control, "start"
        ) as start, mock.patch.object(
            manager.graph_events, "start"
        ) as subscribe, mock.patch.object(
            manager, "safe_reconcile"
        ) as reconcile, mock.patch.object(manager, "request_voice_meter") as meter:
            self.assertEqual(manager.execute(), 0)
        start.assert_not_called()
        subscribe.assert_not_called()
        reconcile.assert_not_called()
        meter.assert_not_called()
        self.assertFalse(manager.commands.meter_listeners)

    def test_cleanup_continues_after_a_monitor_fails_to_stop(self) -> None:
        manager = self.make_manager({})
        manager.modules.adopt("aux", 60)
        with mock.patch.object(
            manager.graph_events, "stop", side_effect=OSError("process gone")
        ), mock.patch.object(
            manager.control, "close", wraps=manager.control.close
        ) as close_control, mock.patch.object(
            pactl, "unload_module"
        ) as unload, self.assertLogs("audio_manager.daemon", level="WARNING"):
            manager._close()
        close_control.assert_called_once()
        unload.assert_called_once_with(60)
        self.assertIsNone(manager.selector.get_map())

    def test_loop_failure_closes_resources_and_withdraws_readiness(self) -> None:
        manager = self.make_manager({})
        manager.status_path.write_text('{"sink": "hifi"}')
        manager.modules.adopt("aux", 60)
        connection = mock.Mock()
        manager.commands.apply(connection, {"command": "set-duck", "active": True})
        manager.control.clients[connection] = b""
        with mock.patch.object(manager, "wait_for_pulse"), mock.patch.object(
            manager.control, "start"
        ), mock.patch.object(manager.graph_events, "start"), mock.patch.object(
            manager, "safe_reconcile"
        ), mock.patch.object(
            manager, "_wait_for_work", side_effect=RuntimeError("loop failed")
        ), mock.patch.object(
            manager.graph_events, "stop"
        ) as stop_events, mock.patch.object(
            manager.voice_meter, "close"
        ) as close_meter, mock.patch.object(
            manager.selector, "close"
        ) as close_selector, mock.patch.object(
            manager, "safe_apply_ducking"
        ) as duck, mock.patch.object(pactl, "unload_module") as unload:
            with self.assertRaisesRegex(RuntimeError, "loop failed"):
                manager.execute()
        stop_events.assert_called_once()
        close_meter.assert_called_once()
        close_selector.assert_called_once()
        connection.close.assert_called_once()
        duck.assert_not_called()
        unload.assert_called_once_with(60)
        self.assertFalse(manager.running)
        self.assertFalse(manager.status_path.exists())


class ExternalClientTests(ManagerTestCase):
    def test_client_owned_trim_is_respected_on_the_bus_but_not_on_hardware(self) -> None:
        from audio_manager.output import hold_client_streams
        manager = self.make_manager({})
        sink = {"name": "music", "index": 2}
        streams: list[graph.Node] = [
            {"index": 10, "sink": 2, "properties": {"smartamp.volume.owner": "client"},
             "volume": {"mono": {"value_percent": "25%"}}},
            {"index": 11, "sink": 2, "properties": {},
             "volume": {"mono": {"value_percent": "100%"}}},
        ]
        with self._patched_graph({"sink-inputs": streams}, fake_run), mock.patch.object(
            pactl, "set_sink_input_volume"
        ) as write:
            hold_client_streams(manager.graph, sink, 80, respect_client_volume=True)
            write.assert_called_once_with(11, 80)
            write.reset_mock()
            hold_client_streams(manager.graph, sink, 40)
            self.assertEqual(write.call_args_list, [mock.call(10, 40), mock.call(11, 40)])

    def test_external_input_activity_wakes_the_graph_and_its_removal_allows_idle(self) -> None:
        manager = self.make_manager({})
        streams: list[graph.Node] = [{"index": 10, "corked": False, "properties": {
            "media.name": "Input client", "smartamp.volume.owner": "client",
        }}]
        with self._patched_graph({"sink-inputs": streams}, fake_run):
            self.assertTrue(manager._audio_active())
            streams.clear()
            manager.graph.invalidate()
            self.assertFalse(manager._audio_active())

    def test_volume_commands_publish_the_bus_register_immediately(self) -> None:
        manager = self.make_manager({"music_bus": {"enabled": True}})
        sink = {"name": "smartamp_music", "index": 2,
                "volume": {"mono": {"value_percent": "40%"}}, "mute": False}
        with self._patched_graph({"sinks": [sink]}, fake_run) as commands:
            manager.set_music_volume(60)
            self.assertIn(("pactl", "set-sink-volume", "smartamp_music", "60%"),
                          [call.args for call in commands.call_args_list])

    def test_monitor_restart_deadline_wakes_an_otherwise_idle_selector(self) -> None:
        manager = self.make_manager({})
        manager.next_resync = 900
        with mock.patch.object(manager.graph_events, "deadline", return_value=101), mock.patch(
            "audio_manager.daemon.time.monotonic", return_value=100
        ), mock.patch.object(manager.selector, "select", return_value=[]) as select:
            manager._wait_for_work()
        select.assert_called_once_with(1)
