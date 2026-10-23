"""The voice bus: a reply put into it reaches the output at the voice level,
and the meter the ring pulses to reports it while a lease is held."""

from __future__ import annotations

from ..audio import Player, STIMULUS_AMPLITUDE, capture, expected_gain_db, to_db
from ..control import section
from ..session import QUIET_VOICE_VOLUME, Session


TIER = "voice"

READY_SECONDS = 8.0
METER_SECONDS = 2.0
TOLERANCE_DB = 3.0
# A -20 dBFS tone on a meter whose floor is -45 dB reads about 0.55.
MIN_METER_LEVEL = 0.3


def run(session: Session) -> None:
    config = session.config
    if not config.voice.enabled:
        session.skip(TIER, "voice bus", "the voice assistant is disabled on this unit")
        return
    if session.in_use(TIER):
        return
    monitor = session.output_monitor()
    if monitor is None:
        session.check(TIER, "output sink is in the graph", False, config.output_match)
        return
    session.quieten()
    control = session.control
    control.command("set-voice-meter", active=True)
    try:
        ready = control.wait_for(
            lambda state: section(state, "voice_bus", "available") is True, READY_SECONDS
        )
        if not session.check(TIER, "a meter lease brings the voice bus up", ready is not None):
            return
        with Player(session.runtime, config.voice_sink, session.tone()):
            session.settle()
            events = control.drain(METER_SECONDS)
            levels = [
                float(event["level"])
                for event in events
                if event.get("event") == "voice_level" and isinstance(event.get("level"), (int, float))
            ]
            peak = max(levels, default=0.0)
            session.check(TIER, "the voice meter reports the reply",
                          peak >= MIN_METER_LEVEL,
                          f"peak level {peak:.2f} over {len(levels)} readings")
            heard = capture(session.runtime, monitor, 1.0)
            expected = to_db(STIMULUS_AMPLITUDE) + expected_gain_db(QUIET_VOICE_VOLUME)
            if heard is None:
                session.check(TIER, "the voice bus reaches the output", False,
                              "nothing could be captured from the monitor")
            else:
                session.check(TIER, f"the voice bus reaches the output at {QUIET_VOICE_VOLUME}%",
                              abs(heard.tone_db - expected) <= TOLERANCE_DB,
                              f"{heard.describe()}, expected tone {expected:.1f} dBFS")
        session.settle()
        # Levels from while the tone played are still queued unread.
        control.discard()
        quiet = [
            float(event["level"])
            for event in control.drain(1.0)
            if event.get("event") == "voice_level"
        ]
        session.check(TIER, "the meter falls silent after the reply",
                      not quiet or max(quiet) < MIN_METER_LEVEL,
                      f"peak level {max(quiet, default=0.0):.2f} after the tone stopped")
    finally:
        control.command("set-voice-meter", active=False)
