"""The control socket's vocabulary: every command the controller can send,
what it does to the published state, and what a bad one is answered with."""

from __future__ import annotations

from typing import Any

from ..config import SILENT_CEILING_PERCENT
from ..control import ControlClient, section
from ..session import Session


TIER = "commands"
LEASE_RELEASE_SECONDS = 3.0
ROUND_TRIP_SECONDS = 2.0


def run(session: Session) -> None:
    control = session.control
    config = session.config

    state = control.command("get-state")
    session.check(TIER, "get-state answers with the state",
                  state.get("event") == "state" and "music_bus" in state)
    _rejects(session, "an unknown command is refused", control.command("no-such-command"))
    _rejects(session, "a level above 100 is refused",
             control.command("set-music-volume", percent=101))
    _rejects(session, "a level that is not a number is refused",
             control.command("set-music-volume", percent="loud"))
    _rejects(session, "a duck without a boolean is refused",
             control.command("set-duck", active="yes"))

    if session.in_use(TIER):
        return

    _round_trip(session, "set-music-volume sets the music level",
                control.command("set-music-volume", percent=42), ("music_bus", "volume"), 42)
    _round_trip(session, "set-music-mute mutes the music",
                control.command("set-music-mute", muted=True), ("music_bus", "muted"), True)
    _round_trip(session, "set-music-mute unmutes the music",
                control.command("set-music-mute", muted=False), ("music_bus", "muted"), False)
    if config.voice.enabled:
        _round_trip(session, "set-voice-volume sets the voice level",
                    control.command("set-voice-volume", percent=35), ("voice_bus", "volume"), 35)

    if config.ceiling is not None:
        floor = SILENT_CEILING_PERCENT
        _rejects(session, f"a ceiling under {floor}% is refused",
                 control.command("set-output-ceiling", percent=floor - 1))
        state = control.command("set-output-ceiling", percent=floor)
        _round_trip(session, f"set-output-ceiling moves the hardware ceiling to {floor}%",
                    state, ("output_volume",), floor)
        read_back = session.runtime.amixer_percent(config.ceiling.card, config.ceiling.control)
        session.check(TIER, "the card reads the ceiling the manager set",
                      read_back == floor, f"amixer reads {read_back}%")
    else:
        _rejects(session, "a unit with no ceiling refuses to set one",
                 control.command("set-output-ceiling", percent=80))

    first = next(iter(config.sources), None)
    if first is not None:
        _round_trip(session, f"set-source-trim trims {first}",
                    control.command("set-source-trim", name=first, percent=55),
                    ("sources", first, "trim"), 55)
    _rejects(session, "a trim for an unknown source is refused",
             control.command("set-source-trim", name="nowhere", percent=50))
    for name, source in config.sources.items():
        if source.switchable:
            before = bool(section(control.state(), "sources", name, "enabled"))
            toggled = control.command("set-source-state", name=name, state="toggle")
            _round_trip(session, f"set-source-state toggles {name}", toggled,
                        ("sources", name, "enabled"), not before)
            control.command("set-source-state", name=name, state="on" if before else "off")
        else:
            _rejects(session, f"{name} cannot be switched, and says so",
                     control.command("set-source-state", name=name, state="toggle"))

    resynced = control.command("resync")
    session.check(TIER, "resync reconciles and answers with the state",
                  resynced.get("event") == "state")

    if config.voice.ducking:
        _lease_follows_connection(session)


def _lease_follows_connection(session: Session) -> None:
    other = ControlClient(session.config.socket)
    other.connect()
    try:
        state = other.command("set-duck", active=True)
        session.check(TIER, "a second client can hold a duck",
                      section(state, "music_bus", "ducked") is True)
    finally:
        other.close()
    released = session.control.wait_for(
        lambda state: section(state, "music_bus", "ducked") is False, LEASE_RELEASE_SECONDS
    )
    session.check(TIER, "closing the socket releases its duck", released is not None,
                  f"still ducked {LEASE_RELEASE_SECONDS:.0f}s after the client left")


def _rejects(session: Session, name: str, reply: dict[str, Any]) -> None:
    session.check(TIER, name, reply.get("event") == "error", str(reply.get("error", reply)))


def _round_trip(session: Session, name: str, reply: dict[str, Any], path: tuple[str, ...],
                expected: object) -> None:
    if reply.get("event") != "state":
        session.check(TIER, name, False, str(reply.get("error", reply)))
        return
    landed = session.control.wait_for(lambda state: section(state, *path) == expected,
                                      ROUND_TRIP_SECONDS)
    actual = section(landed, *path) if landed else section(session.control.state(), *path)
    session.check(TIER, name, landed is not None, f"state reads {actual!r}")
