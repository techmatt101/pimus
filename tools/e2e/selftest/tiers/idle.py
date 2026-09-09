"""Idle teardown and the rebuild: the bridges go when the amp is quiet and
come back, from silence, the moment something plays."""

from __future__ import annotations

from ..audio import Player, STIMULUS_AMPLITUDE, capture, expected_gain_db, to_db
from ..control import section
from ..session import QUIET_MUSIC_VOLUME, Session


TIER = "idle"

TEARDOWN_SECONDS = 8.0
REBUILD_SECONDS = 8.0
TOLERANCE_DB = 3.0


def run(session: Session) -> None:
    if not session.config.idle_teardown:
        session.skip(TIER, "idle teardown", "disabled on this unit")
        return
    if session.in_use(TIER):
        return
    monitor = session.output_monitor()
    if monitor is None:
        session.check(TIER, "output sink is in the graph", False, session.config.output_match)
        return
    session.quieten()
    control = session.control
    control.command("force-idle")
    idle = control.wait_for(lambda state: state.get("idle") is True, TEARDOWN_SECONDS)
    if not session.check(TIER, "force-idle tears the bridges down", idle is not None,
                         f"not idle after {TEARDOWN_SECONDS:.0f}s; a lease or a stream is holding it"):
        return
    assert idle is not None
    session.check(TIER, "the music bridge is unloaded while idle",
                  not session.bridge_present("music_bridge"))
    session.check(TIER, "the music bus sink stays for its clients",
                  bool(section(idle, "music_bus", "sink")))
    if session.config.aec_reference:
        session.check(TIER, "the echo reference is released while idle",
                      section(idle, "aec_reference", "available") is False)
        session.check(TIER, "the echo reference endpoints are still there",
                      section(idle, "aec_reference", "endpoints_available") is True,
                      "the array's playback sink or the output monitor is missing")

    with Player(session.runtime, session.config.music_sink, session.tone()):
        woken = control.wait_for(
            lambda state: state.get("idle") is False and section(state, "music_bus", "available") is True,
            REBUILD_SECONDS,
        )
        if not session.check(TIER, "a stream wakes the bridges", woken is not None,
                             f"not rebuilt after {REBUILD_SECONDS:.0f}s"):
            return
        session.settle()
        heard = capture(session.runtime, monitor, 1.0)
        expected = to_db(STIMULUS_AMPLITUDE) + expected_gain_db(QUIET_MUSIC_VOLUME)
        if heard is None:
            session.check(TIER, "the rebuilt bridge carries sound", False,
                          "nothing could be captured from the monitor")
        else:
            session.check(TIER, "the rebuilt bridge fades in to the music level",
                          abs(heard.tone_db - expected) <= TOLERANCE_DB,
                          f"{heard.describe()}, expected tone {expected:.1f} dBFS")
        if session.config.aec_reference:
            reference = control.wait_for(
                lambda state: section(state, "aec_reference", "available") is True, REBUILD_SECONDS
            )
            session.check(TIER, "the echo reference is rebuilt with the bridges",
                          reference is not None)
