"""Opt-in: restart the daemons the way a deploy does and watch them find each
other again. The manager is restarted alone first, because its dependants
are only required to stop with it and nothing requires them to start."""

from __future__ import annotations

import time

from ..session import Session


TIER = "recovery"

MANAGER = "smartamp-audio-manager"
CONTROLLER = "smartamp-controller"
DEPENDANTS = ("smartamp-sendspin", "smartamp-voice-assistant", "smartamp-audio-inputs")
STATUS_SECONDS = 30.0
DEPENDANT_SECONDS = 15.0
READY_SECONDS = 90.0
CONTROLLER_SECONDS = 30.0


def run(session: Session) -> None:
    if not session.options.restart:
        session.skip(TIER, "restart recovery", "pass --restart to restart the daemons")
        return
    if session.in_use(TIER):
        return
    config = session.config
    runtime = session.runtime
    # The manager saves its levels on the clean exit a restart makes, so the
    # user's go back first or the test's would be the ones it restores.
    session.restore()
    session.control.close()

    wanted = [unit for unit in DEPENDANTS if unit in config.services]
    session.check(TIER, "the audio manager restarts", runtime.systemctl("restart", MANAGER))
    published = session.wait_until(
        lambda: bool((session.status() or {}).get("sink")), STATUS_SECONDS
    )
    session.check(TIER, "the manager republishes its status", published,
                  f"no output sink within {STATUS_SECONDS:.0f}s")

    time.sleep(DEPENDANT_SECONDS)
    for unit in wanted:
        active = runtime.unit_active(unit)
        session.check(TIER, f"{unit} follows the manager back up", active,
                      "stopped with the manager and not restarted; starting it", warn=True)
        if not active:
            runtime.systemctl("start", "--no-block", unit)
    ready = session.wait_until(lambda: all(runtime.unit_active(u) for u in wanted), READY_SECONDS)
    session.check(TIER, "every audio client is active again", ready,
                  ", ".join(u for u in wanted if not runtime.unit_active(u)))

    session.control.connect()
    if config.controller:
        session.check(TIER, "the controller restarts", runtime.systemctl("restart", CONTROLLER))
        expectations = [
            ("the controller reconnects to the voice assistant", "connected to voice assistant",
             config.voice.enabled),
            ("the controller reconnects to Home Assistant", "connected to Home Assistant",
             config.home_assistant),
            ("the controller reopens the Stream Deck", "opened Stream Deck",
             config.streamdeck is not None),
        ]
        for name, needle, expected in expectations:
            if not expected:
                continue
            seen = session.wait_until(
                lambda: needle in (runtime.journal_since_start(CONTROLLER) or ""),
                CONTROLLER_SECONDS,
            )
            session.check(TIER, name, seen, f'no "{needle}" within {CONTROLLER_SECONDS:.0f}s')
        session.check(TIER, "the controller holds the audio manager socket",
                      "socket error" not in (runtime.journal_since_start(CONTROLLER) or ""))
