"""Is everything that should be running, running, and did it find its peers."""

from __future__ import annotations

from ..control import section
from ..session import Session


TIER = "services"

CONTROLLER = "smartamp-controller"
SOCKET_ERROR = "socket error"


def run(session: Session) -> None:
    config = session.config
    runtime = session.runtime
    for unit in config.services:
        session.check(TIER, f"{unit} is active", runtime.unit_active(unit))
    if config.controller:
        session.check(TIER, f"{CONTROLLER} is active", runtime.unit_active(CONTROLLER))

    status = session.status()
    if not session.check(TIER, "audio status is published", status is not None,
                         str(config.status)):
        return
    assert status is not None
    session.check(TIER, "output sink is selected", bool(status.get("sink")),
                  str(status.get("sink")))
    session.check(
        TIER, "music bus is published",
        bool(section(status, "music_bus", "sink")),
        str(section(status, "music_bus", "sink")),
    )
    if config.voice.enabled:
        session.check(
            TIER, "voice bus is published",
            bool(section(status, "voice_bus", "sink")),
            str(section(status, "voice_bus", "sink")),
        )
    published = set(session.status_sources(status))
    expected = set(config.sources)
    session.check(
        TIER, "the mixer knows every configured source",
        published == expected,
        f"published {sorted(published)}, configured {sorted(expected)}",
    )
    if config.inputs_status is not None:
        session.check(TIER, "audio inputs status is published",
                      session.inputs_status() is not None, str(config.inputs_status))

    if config.controller:
        _controller_connections(session)


def _controller_connections(session: Session) -> None:
    runtime = session.runtime
    journal = runtime.journal_since_start(CONTROLLER)
    if journal is None:
        session.warn(TIER, "controller journal", "could not read the controller's log")
        return
    expectations = [
        ("controller reached the voice assistant", "connected to voice assistant",
         session.config.voice.enabled),
        ("controller reached Home Assistant", "connected to Home Assistant",
         session.config.home_assistant),
        ("controller opened the Stream Deck", "opened Stream Deck",
         session.config.streamdeck is not None),
    ]
    for name, needle, wanted in expectations:
        if wanted:
            session.check(TIER, name, needle in journal, f'no "{needle}" line since it started')
    recent = runtime.journal(CONTROLLER, "-60s")
    session.check(
        TIER, "controller holds the audio manager socket",
        SOCKET_ERROR not in recent,
        "the controller logged a socket error in the last minute",
    )
