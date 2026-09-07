"""Gain transitions must leave control and graph recovery responsive."""

from __future__ import annotations

# pyright: reportPrivateUsage=false

from unittest import mock

from test_audio_manager import ManagerTestCase, fake_run
from audio_manager.schedule import ReconcileSchedule
from smartamp_audio import graph, pactl


class AudioTimingTests(ManagerTestCase):
    def test_mute_interrupts_a_duck_without_waiting_for_the_old_ramp(self) -> None:
        manager = self.make_manager({"music_bus": {"enabled": True, "fade_ms": 250}})
        manager.music_bus.stream_index = 42
        with self._patched_graph({}, fake_run), mock.patch.object(
            manager.fades, "_clock", return_value=0.0
        ) as clock, mock.patch.object(pactl, "set_sink_input_volume") as write:
            manager.music_bus.apply_ducking(100, False)
            write.reset_mock()
            manager.music_bus.apply_ducking(100, True)
            write.assert_not_called()
            clock.return_value = 0.1
            manager.fades.tick()
            self.assertGreater(write.call_args.args[1], 15)
            manager.commands.apply(mock.Mock(), {"command": "set-music-mute", "muted": True})
            write.assert_called_with(42, 0)
            self.assertIsNone(manager.fades.deadline())
            write.reset_mock()
            clock.return_value = 1.0
            manager.fades.tick()
            write.assert_not_called()

    def test_duck_reversal_starts_at_the_last_applied_level(self) -> None:
        manager = self.make_manager({"music_bus": {"enabled": True, "fade_ms": 250}})
        manager.music_bus.stream_index = 42
        with mock.patch.object(manager.fades, "_clock", return_value=0.0) as clock, mock.patch.object(
            pactl, "set_sink_input_volume"
        ) as write:
            manager.music_bus.apply_ducking(100, False)
            manager.music_bus.apply_ducking(100, True)
            clock.return_value = 0.1
            manager.fades.tick()
            self.assertEqual(manager.music_bus.gain_applied, 66)
            manager.music_bus.apply_ducking(100, False)
            self.assertEqual(manager.music_bus.gain_applied, 66)
            clock.return_value = 0.16
            manager.fades.tick()
            self.assertGreater(write.call_args.args[1], 66)
            self.assertLess(write.call_args.args[1], 100)
            self.finish_fades(manager)
            write.assert_called_with(42, 100)

    def test_late_tick_skips_obsolete_steps_and_finishes_both_wake_fades(self) -> None:
        manager = self.make_manager({})
        for index, bus in enumerate((manager.music_bus, manager.voice_bus), 42):
            bus.stream_index = index
            bus.gain_applied = 0
            bus.gain_wanted = 60
            bus.fresh = True
        with mock.patch.object(manager.fades, "_clock", return_value=0.0) as clock, mock.patch.object(
            pactl, "set_sink_input_volume"
        ) as write:
            manager.music_bus.fade_in()
            manager.voice_bus.fade_in()
            write.assert_not_called()
            clock.return_value = 0.3
            manager.fades.tick()
            self.assertEqual(write.call_args_list, [mock.call(42, 60), mock.call(43, 60)])
            self.assertIsNone(manager.fades.deadline())

    def test_selector_wakes_for_fades_without_a_graph_event(self) -> None:
        manager = self.make_manager({"idle_teardown_seconds": 0})
        manager.schedule.resync = 900.0
        manager.music_bus.stream_index = 42
        manager.music_bus.gain_applied = 0
        manager.music_bus.gain_wanted = 60
        manager.music_bus.fresh = True
        with mock.patch.object(manager.fades, "_clock", return_value=0.0):
            manager.music_bus.fade_in()
        with mock.patch.object(manager.graph_events, "deadline", return_value=None), mock.patch(
            "audio_manager.daemon.time.monotonic", return_value=0.0
        ), mock.patch.object(manager.selector, "select", return_value=[]) as select:
            manager._wait_for_work()
        select.assert_called_once_with(0.05)

    def test_releasing_a_bus_cancels_every_pending_write_to_its_old_stream(self) -> None:
        manager = self.make_manager({})
        manager.music_bus.stream_index = 42
        manager.music_bus.gain_applied = 0
        manager.music_bus.gain_wanted = 60
        manager.music_bus.fresh = True
        with mock.patch.object(pactl, "set_sink_input_volume") as write:
            manager.music_bus.fade_in()
            self.assertIsNotNone(manager.fades.deadline())
            manager.music_bus.release()
            self.finish_fades(manager)
            write.assert_not_called()
            self.assertIsNone(manager.music_bus.stream_index)

    def test_a_source_fade_survives_reconciliation_and_is_cancelled_on_removal(self) -> None:
        manager = self.make_manager({"sources": {"aux": {"enabled": True}}})
        bus: graph.Node = {"name": "music", "index": 2}
        stream: graph.Node = {
            "index": 61, "sink": 2, "properties": {"smartamp.source": "aux"},
            "volume": {"mono": {"value_percent": "0%"}},
        }
        listings = {"sink-inputs": [stream]}

        def apply(index: int, level: int) -> None:
            self.assertEqual(index, 61)
            stream["volume"] = {"mono": {"value_percent": f"{level}%"}}

        with self._patched_graph(listings, fake_run), mock.patch.object(
            manager.fades, "_clock", return_value=0.0
        ) as clock, mock.patch.object(pactl, "set_sink_input_volume", side_effect=apply) as write:
            manager.mixer.reconcile(bus)
            write.assert_not_called()
            clock.return_value = 0.1
            manager.fades.tick()
            write.assert_called_once_with(61, 50)
            deadline = manager.fades.deadline()
            manager.graph.invalidate()
            manager.mixer.reconcile(bus)
            self.assertEqual(manager.fades.deadline(), deadline)
            self.assertEqual(write.call_count, 1)
            listings["sink-inputs"] = []
            manager.graph.invalidate()
            manager.mixer.reconcile(bus)
            self.finish_fades(manager)
            self.assertEqual(write.call_count, 1)

    def test_graph_bursts_have_a_bounded_deadline_even_after_volume_writes(self) -> None:
        manager = self.make_manager({})
        with mock.patch.object(pactl, "set_sink_input_volume"):
            manager.music_bus.stream_index = 42
            manager.music_bus.apply_gain(60)
        for now, event in (
            (100.0, b"Event 'change' on sink-input #42"),
            (100.1, b"Event 'change' on sink-input #99"),
            (100.2, b"Event 'change' on sink #2"),
            (100.4, b"Event 'change' on sink-input #100"),
        ):
            with mock.patch("audio_manager.daemon.time.monotonic", return_value=now):
                manager.graph_events._on_line(event)
            self.assertEqual(manager.schedule.booked, 100.3)

    def test_a_booking_is_cleared_as_the_pass_begins_and_the_resync_outlasts_it(self) -> None:
        schedule = ReconcileSchedule(900.0)
        self.assertTrue(schedule.due(0.0))
        schedule.settle(100.0, succeeded=True)
        self.assertEqual(schedule.deadline(), 1000.0)
        schedule.book(100.0)
        schedule.book(100.0, 0.0)
        schedule.book(100.0)
        self.assertEqual(schedule.deadline(), 100.0)
        self.assertTrue(schedule.due(100.0))
        schedule.begin()
        # The pass itself may book the follow-up that the unsettled bridge needs.
        schedule.retry(100.0)
        schedule.settle(100.0, succeeded=False)
        self.assertEqual((schedule.booked, schedule.resync), (101.0, 101.0))
        self.assertFalse(schedule.due(100.5))
        self.assertTrue(schedule.due(101.0))
