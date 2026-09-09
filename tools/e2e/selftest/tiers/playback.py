"""Does a tone put into the music bus reach the output, at the gains the
manager says it applies: the level, a level step, a duck, and the mute.

Near-silent: the ceiling is parked at its floor and the level kept low, so
the tone reaches the amplifier some 80 dB down and only the graph hears it.
"""

from __future__ import annotations

from ..audio import Measurement, Player, STIMULUS_AMPLITUDE, capture, expected_gain_db, to_db
from ..control import section
from ..session import QUIET_MUSIC_VOLUME, Session


TIER = "playback"

STEP_VOLUME = 60
TOLERANCE_DB = 3.0
# The most a tone may still show after a duck or a mute before it counts as
# still audible; PipeWire's float path leaves a ducked tone well under this.
SILENCED_DROP_DB = 40.0
CAPTURE_SECONDS = 1.0


def run(session: Session) -> None:
    if session.in_use(TIER):
        return
    monitor = session.output_monitor()
    if not session.check(TIER, "output sink is in the graph", monitor is not None,
                         session.config.output_match):
        return
    assert monitor is not None
    session.quieten()
    music_monitor = f"{session.config.music_sink}.monitor"
    with Player(session.runtime, session.config.music_sink, session.tone()):
        session.settle()
        at_bus = capture(session.runtime, music_monitor, CAPTURE_SECONDS)
        if not _present(session, "tone reaches the music bus", at_bus,
                        to_db(STIMULUS_AMPLITUDE)):
            return
        baseline = capture(session.runtime, monitor, CAPTURE_SECONDS)
        if not _present(session, f"tone reaches the output at {QUIET_MUSIC_VOLUME}%",
                        baseline, to_db(STIMULUS_AMPLITUDE) + expected_gain_db(QUIET_MUSIC_VOLUME)):
            return
        assert baseline is not None

        session.control.command("set-music-volume", percent=STEP_VOLUME)
        session.settle()
        stepped = capture(session.runtime, monitor, CAPTURE_SECONDS)
        expected = expected_gain_db(STEP_VOLUME) - expected_gain_db(QUIET_MUSIC_VOLUME)
        _delta(session, f"a level step {QUIET_MUSIC_VOLUME}% to {STEP_VOLUME}% is heard",
               baseline, stepped, expected)

        if session.config.voice.ducking:
            state = session.control.command("set-duck", active=True)
            session.settle()
            ducked = capture(session.runtime, monitor, CAPTURE_SECONDS)
            session.check(TIER, "a duck lease ducks the bus",
                          section(state, "music_bus", "ducked") is True)
            duck_gain = expected_gain_db(round(STEP_VOLUME * session.config.duck_volume_percent / 100))
            _delta(session, f"ducking dips the music to {session.config.duck_volume_percent}% of its level",
                   stepped, ducked, duck_gain - expected_gain_db(STEP_VOLUME),
                   silenced_ok=True)
            session.control.command("set-duck", active=False)
            session.settle()

        session.control.command("set-music-mute", muted=True)
        session.settle()
        muted = capture(session.runtime, monitor, CAPTURE_SECONDS)
        _silenced(session, "the mute silences the music path", stepped, muted)
        session.control.command("set-music-mute", muted=False)
        session.control.command("set-music-volume", percent=QUIET_MUSIC_VOLUME)
        session.settle()


def _present(session: Session, name: str, measured: Measurement | None,
             expected_db: float) -> bool:
    if measured is None:
        return session.check(TIER, name, False, "nothing could be captured from the monitor")
    ok = abs(measured.tone_db - expected_db) <= TOLERANCE_DB
    return session.check(TIER, name, ok,
                         f"{measured.describe()}, expected tone {expected_db:.1f} dBFS")


def _delta(session: Session, name: str, before: Measurement | None,
           after: Measurement | None, expected_db: float, *, silenced_ok: bool = False) -> None:
    if before is None or after is None:
        session.check(TIER, name, False, "nothing could be captured from the monitor")
        return
    delta = after.tone_db - before.tone_db
    ok = abs(delta - expected_db) <= TOLERANCE_DB
    if silenced_ok and not ok:
        ok = delta <= -SILENCED_DROP_DB
    session.check(TIER, name, ok, f"tone moved {delta:+.1f} dB, expected {expected_db:+.1f} dB")


def _silenced(session: Session, name: str, before: Measurement | None,
              after: Measurement | None) -> None:
    if before is None or after is None:
        session.check(TIER, name, False, "nothing could be captured from the monitor")
        return
    drop = before.tone_db - after.tone_db
    session.check(TIER, name, drop >= SILENCED_DROP_DB,
                  f"tone dropped {drop:.1f} dB to {after.tone_db:.1f} dBFS")
