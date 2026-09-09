"""The local inputs: a switchable source's stream appears on the bus, tagged
and trimmed, when it is switched on, and leaves when it is switched off."""

from __future__ import annotations

from typing import Any, cast

from smartamp_audio import graph

from ..control import section
from ..session import Session


TIER = "inputs"

APPEAR_SECONDS = 8.0
LEAVE_SECONDS = 5.0
TRIM = 50


def run(session: Session) -> None:
    config = session.config
    if config.inputs_status is None:
        session.skip(TIER, "local inputs", "this unit has no aux or USB input")
        return
    status = session.inputs_status()
    if not session.check(TIER, "audio inputs status is published", status is not None):
        return
    assert status is not None
    inputs = cast(dict[str, Any], status.get("inputs") or {})
    for name in config.switchable_sources:
        entry = cast(dict[str, Any], inputs.get(name) or {})
        if not session.check(TIER, f"{name} capture node is found", bool(entry.get("node")),
                             "the inputs app has no device for it"):
            continue
        if name == "usb":
            _usb(session, entry)
        else:
            if session.in_use(TIER):
                return
            _capture_input(session, name)


def _usb(session: Session, entry: dict[str, Any]) -> None:
    host = bool(entry.get("host"))
    streaming = bool(entry.get("streaming"))
    if not host:
        session.skip(TIER, "usb host", "no computer is attached to the USB-C port")
        return
    if not streaming:
        session.skip(TIER, "usb stream", "the attached computer is not playing; the "
                     "control computer's e2e tool drives this one")
        return
    session.check(TIER, "usb stream is on the bus while the host plays",
                  bool(entry.get("playing")) and bool(session.source_streams("usb")))


def _capture_input(session: Session, name: str) -> None:
    control = session.control
    before = bool(section(control.state(), "sources", name, "enabled"))
    control.command("set-source-state", name=name, state="on")
    control.command("set-source-trim", name=name, percent=TRIM)
    appeared = session.wait_until(lambda: bool(session.source_streams(name)), APPEAR_SECONDS)
    session.check(TIER, f"switching {name} on puts its stream on the bus", appeared,
                  f"no stream tagged smartamp.source={name} after {APPEAR_SECONDS:.0f}s")
    if appeared:
        stream = session.source_streams(name)[0]
        trimmed = session.wait_until(
            lambda: any(graph.volume_is(s, TRIM) for s in session.source_streams(name)), LEAVE_SECONDS
        )
        session.check(TIER, f"{name} plays at its trim", trimmed,
                      f"stream volume {graph.channel_volumes(stream)}, trim {TRIM}%")
        available = control.wait_for(
            lambda state: section(state, "sources", name, "available") is True, LEAVE_SECONDS
        )
        session.check(TIER, f"the mixer reports {name} available", available is not None)
        inputs = session.inputs_status() or {}
        entry = cast(dict[str, Any], cast(dict[str, Any], inputs.get("inputs") or {}).get(name) or {})
        session.check(TIER, f"the inputs app reports {name} playing", bool(entry.get("playing")))
    control.command("set-source-state", name=name, state="off")
    # The loopback stays on the bus switched off; it is the mixer that
    # silences it, fading the stream to nothing.
    silenced = session.wait_until(
        lambda: all(graph.volume_is(s, 0) for s in session.source_streams(name)), LEAVE_SECONDS
    )
    session.check(TIER, f"switching {name} off silences its stream", silenced)
    control.command("set-source-state", name=name, state="on" if before else "off")
