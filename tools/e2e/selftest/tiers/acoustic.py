"""Audible: does the speaker make sound the microphone array hears, and does
the array's echo canceller lock onto it.

Broadband noise is played at a listening level. The ASR output the assistant
records is measured before and during, so the room's own quiet is the
reference: an amplifier that is dead, a speaker that is unplugged, or an
array that is deaf all fail here and nowhere else. The convergence flag is
read as supporting evidence, because it latches.
"""

from __future__ import annotations

import time

from ..audio import Player, capture
from ..control import section
from ..session import Session


TIER = "acoustic"

NOISE_AMPLITUDE = 0.3
BASELINE_SECONDS = 1.5
HEARD_SECONDS = 1.5
CONVERGE_WAIT_SECONDS = 3.0


def run(session: Session) -> None:
    config = session.config
    if session.options.silent:
        session.skip(TIER, "acoustic", "--silent")
        return
    if config.respeaker is None or not config.voice.enabled:
        session.skip(TIER, "acoustic", "no microphone array to listen with")
        return
    if session.in_use(TIER):
        return
    source = config.voice.capture_name or config.voice.input_name
    if source not in session.runtime.source_names():
        session.check(TIER, "voice capture source is published", False, source)
        return

    level = session.options.music_volume or config.acoustic.music_volume
    min_rise = session.options.min_rise_db or config.acoustic.min_rise_db
    control = session.control
    if config.ceiling is not None:
        control.command("set-output-ceiling", percent=config.ceiling.percent)
    control.command("set-music-mute", muted=False)
    control.command("set-music-volume", percent=level)
    for name in config.sources:
        control.command("set-source-trim", name=name, percent=100)
    session.settle()

    quiet = capture(session.runtime, source, BASELINE_SECONDS)
    if quiet is None:
        session.check(TIER, "the array can be recorded", False, source)
        return
    noise = session.noise(config.acoustic.noise_seconds, NOISE_AMPLITUDE)
    with Player(session.runtime, config.music_sink, noise) as player:
        awake = control.wait_for(
            lambda state: section(state, "music_bus", "available") is True, 5.0
        )
        session.check(TIER, "the music bus is up for the stimulus", awake is not None)
        session.settle()
        heard = capture(session.runtime, source, HEARD_SECONDS)
        converged = None
        if config.respeaker.host_control:
            remaining = CONVERGE_WAIT_SECONDS - HEARD_SECONDS - 0.7
            if remaining > 0 and player.running:
                time.sleep(remaining)
            converged = session.runtime.xvf_host("AEC_AECCONVERGED")
    if heard is None:
        session.check(TIER, "the array hears the speaker", False, "the capture stopped early")
        return
    rise = heard.rms_db - quiet.rms_db
    session.check(
        TIER, f"the array hears the speaker at {level}%",
        rise >= min_rise,
        f"ASR output rose {rise:+.1f} dB over the quiet room ({quiet.rms_db:.1f} to "
        f"{heard.rms_db:.1f} dBFS), needed {min_rise:+.1f} dB",
    )
    if config.respeaker.host_control:
        session.check(
            TIER, "the echo canceller converged on the stimulus",
            converged is not None and converged.strip().endswith("1"),
            f"AEC_AECCONVERGED reads {converged!r}; latched, so supporting evidence only",
            warn=True,
        )
