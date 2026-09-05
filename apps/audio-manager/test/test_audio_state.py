"""State transitions across routing, client connections, and failed I/O."""

from __future__ import annotations

import json
import selectors
import socket
from typing import Any
from unittest import mock

from test_audio_manager import ManagerTestCase, fake_run, volume_writes
from audio_manager.daemon import AudioManager
from audio_manager.system import pactl, usb_gadget
from audio_manager.usb.volume_sync import UsbVolumeSync


class RouteStateTests(ManagerTestCase):
    def test_background_route_obeys_off_toggle_and_keeps_only_its_own_trim(self) -> None:
        manager = self.make_manager(
            {"sources": {"aux": {
                "match": "ADC",
                "target": "background",
                "mute_when_off": True,
                "volume_percent": 50,
            }}}
        )
        stream = {"index": 61, "owner_module": 60}
        listings = {
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
            return manager.routes.reconcile(
                output={"name": "hifi"},
                background_sink={"name": "background"},
                music_volume=40,
                usb_playback=False,
            )

        with self._patched_graph(listings, run) as commands, mock.patch(
            "audio_manager.volume.time.sleep"
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

    def test_failed_route_fade_can_be_reversed_and_retried(self) -> None:
        manager = self.make_manager(
            {"sources": {"aux": {"match": "ADC", "mute_when_off": True}}}
        )
        stream = {"index": 61, "owner_module": 60}
        manager.modules.adopt("aux", 60)
        with self._patched_graph({"sink-inputs": [stream]}, fake_run), mock.patch(
            "audio_manager.volume.time.sleep"
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
        manager = self.make_manager({"background": {"enabled": True}})
        sender, _ = self._client(manager)
        _, listener = self._client(manager)
        for command, field, expected in (
            ({"command": "set-voice-volume", "percent": 35}, "voice_volume", 35),
            ({"command": "set-duck", "active": True}, "ducked", True),
        ):
            manager.control._handle(sender, json.dumps(command).encode())
            manager._broadcast_changes()
            self.assertEqual(json.loads(listener.recv(4096))[field], expected)
        manager.control.drop(sender)
        manager._broadcast_changes()
        self.assertFalse(json.loads(listener.recv(4096))["ducked"])

    def test_broadcast_detects_route_mutations_and_ignores_unchanged_state(self) -> None:
        manager = self.make_manager({"sources": {"aux": {}}})
        with mock.patch.object(manager.control, "broadcast") as broadcast:
            manager._broadcast_changes()
            broadcast.assert_not_called()
            manager.routes.set_enabled("aux", True)
            manager._broadcast_changes()
            broadcast.assert_called_once()
            self.assertEqual(broadcast.call_args.args[0]["sources"], {"aux": True})
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
        manager = self.make_manager({"background": {"enabled": True, "fade_ms": 100}})
        manager.background.stream_index = 42
        with mock.patch.object(pactl, "set_sink_input_volume") as write, mock.patch(
            "audio_manager.volume.time.sleep"
        ):
            manager.background.apply_ducking(100, False)
            write.side_effect = [None, OSError("write failed mid-fade")]
            with self.assertRaises(OSError):
                manager.background.apply_ducking(100, True)
            write.side_effect = None
            write.reset_mock()
            manager.background.apply_ducking(100, False)
            write.assert_called_once_with(42, 100)


class UsbAgreementTests(ManagerTestCase):
    def test_reappearing_gadget_is_seeded_from_the_amp(self) -> None:
        sync = UsbVolumeSync()
        with mock.patch.object(
            usb_gadget, "card_present", return_value=True
        ) as present, mock.patch.object(
            usb_gadget, "read_mixer", return_value=(40, False)
        ) as read, mock.patch.object(usb_gadget, "write_mixer") as write:
            self.assertEqual(sync.sync((40, False)), (40, False))
            present.return_value = False
            self.assertEqual(sync.sync((40, False)), (40, False))
            present.return_value = True
            read.side_effect = [(100, False), (40, False)]
            write.reset_mock()
            self.assertEqual(sync.sync((40, False)), (40, False))
            write.assert_called_once_with(40, False)


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
            manager.mixer_events, "stop"
        ) as stop_mixer, mock.patch.object(
            manager.voice_meter, "close"
        ) as close_meter, mock.patch.object(
            manager.selector, "close"
        ) as close_selector, mock.patch.object(
            manager, "safe_apply_ducking"
        ) as duck, mock.patch.object(pactl, "unload_module") as unload:
            with self.assertRaisesRegex(RuntimeError, "loop failed"):
                manager.execute()
        stop_events.assert_called_once()
        stop_mixer.assert_called_once()
        close_meter.assert_called_once()
        close_selector.assert_called_once()
        connection.close.assert_called_once()
        duck.assert_not_called()
        unload.assert_called_once_with(60)
        self.assertFalse(manager.running)
        self.assertFalse(manager.status_path.exists())
