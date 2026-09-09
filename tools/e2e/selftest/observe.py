"""What the control computer's e2e tool asks the amp to watch for while it
stimulates the amp from outside: a computer playing into the USB-C port, a
player streaming, the voice satellite announcing, an automation's event.

Each observation runs for a fixed window and answers with JSON, so the tool
can start it, act, and read back what the amp saw.
"""

from __future__ import annotations

import time
from typing import Any, Callable, cast

from .audio import Measurement, capture
from .control import section
from .session import Session


OBSERVATIONS: dict[str, str] = {
    "usb": "a computer playing into the USB-C sound card",
    "player": "a player streaming into the music bus",
    "voice": "the voice satellite speaking a reply",
    "notify": "a Home Assistant event reaching the controller",
}

CONTROLLER = "smartamp-controller"
POLL_SECONDS = 0.25


def observe(session: Session, what: str, seconds: float, marker: str) -> dict[str, Any]:
    watchers: dict[str, Callable[[Session, float, str], dict[str, Any]]] = {
        "usb": _usb,
        "player": _player,
        "voice": _voice,
        "notify": _notify,
    }
    result = watchers[what](session, seconds, marker)
    return {"observation": what, "seconds": seconds, **result}


def _watch(seconds: float, sample: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
    """Runs `sample` until it answers True or the window closes."""
    seen: dict[str, Any] = {}
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if sample(seen):
            break
        time.sleep(POLL_SECONDS)
    return seen


def _usb(session: Session, seconds: float, _: str) -> dict[str, Any]:
    control = session.control
    was_enabled = section(control.state(), "sources", "usb", "enabled")
    control.command("set-source-state", name="usb", state="on")
    session.quieten()
    monitor = session.output_monitor()
    try:
        def sample(seen: dict[str, Any]) -> bool:
            inputs = session.inputs_status() or {}
            entry = cast(dict[str, Any], cast(dict[str, Any], inputs.get("inputs") or {}).get("usb") or {})
            seen["host"] = seen.get("host") or bool(entry.get("host"))
            seen["streaming"] = seen.get("streaming") or bool(entry.get("streaming"))
            seen["playing"] = seen.get("playing") or bool(entry.get("playing"))
            on_bus = bool(session.source_streams("usb"))
            seen["stream_on_bus"] = seen.get("stream_on_bus") or on_bus
            if on_bus and monitor and "tone_db" not in seen:
                session.settle()
                heard = capture(session.runtime, monitor, 1.0)
                _record(seen, heard)
                return True
            return False

        return _watch(seconds, sample)
    finally:
        if was_enabled is not True:
            control.command("set-source-state", name="usb", state="off")


def _player(session: Session, seconds: float, _: str) -> dict[str, Any]:
    session.quieten()
    monitor = session.output_monitor()

    def sample(seen: dict[str, Any]) -> bool:
        state = session.control.state()
        streams = session.bus_streams(session.config.music_sink)
        live = [s for s in streams if not s.get("corked", False)]
        seen["stream_on_bus"] = seen.get("stream_on_bus") or bool(live)
        seen["source_available"] = seen.get("source_available") or (
            section(state, "sources", "sendspin", "available") is True
        )
        seen["bus_available"] = seen.get("bus_available") or (
            section(state, "music_bus", "available") is True
        )
        if live and monitor and "rms_db" not in seen:
            session.settle()
            _record(seen, capture(session.runtime, monitor, 1.0))
            return True
        return False

    return _watch(seconds, sample)


def _voice(session: Session, seconds: float, _: str) -> dict[str, Any]:
    control = session.control
    session.quieten()
    monitor = session.output_monitor()
    control.command("set-voice-meter", active=True)
    try:
        seen: dict[str, Any] = {"ducked": False, "voice_stream": False, "peak_level": 0.0}
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            for event in control.drain(POLL_SECONDS):
                if event.get("event") == "voice_level":
                    seen["peak_level"] = max(float(seen["peak_level"]), float(event.get("level", 0.0)))
                elif event.get("event") == "state" and section(event, "music_bus", "ducked") is True:
                    seen["ducked"] = True
            state = control.state()
            if section(state, "music_bus", "ducked") is True:
                seen["ducked"] = True
            streams = session.bus_streams(session.config.voice_sink)
            if any(not s.get("corked", False) for s in streams):
                seen["voice_stream"] = True
                if monitor and "rms_db" not in seen:
                    _record(seen, capture(session.runtime, monitor, 1.0))
        return seen
    finally:
        control.command("set-voice-meter", active=False)


def _notify(session: Session, seconds: float, marker: str) -> dict[str, Any]:
    def sample(seen: dict[str, Any]) -> bool:
        journal = session.runtime.journal(CONTROLLER, "-2min")
        seen["seen"] = marker in journal
        return bool(seen["seen"])

    return _watch(seconds, sample)


def _record(seen: dict[str, Any], heard: Measurement | None) -> None:
    if heard is None:
        seen["rms_db"] = None
        seen["tone_db"] = None
    else:
        seen["rms_db"] = round(heard.rms_db, 1)
        seen["tone_db"] = round(heard.tone_db, 1)
