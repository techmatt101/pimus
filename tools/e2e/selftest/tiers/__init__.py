"""The tiers, in the order they run: the cheap and silent ones first, the
audible one after, and the one that restarts daemons last."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..session import Session
from . import acoustic, commands, hardware, idle, inputs, playback, recovery, services, voice


@dataclass(frozen=True)
class Tier:
    name: str
    run: Callable[[Session], None]
    audible: bool = False


TIERS: tuple[Tier, ...] = (
    Tier(services.TIER, services.run),
    Tier(hardware.TIER, hardware.run),
    Tier(commands.TIER, commands.run),
    Tier(playback.TIER, playback.run),
    Tier(idle.TIER, idle.run),
    Tier(voice.TIER, voice.run),
    Tier(inputs.TIER, inputs.run),
    Tier(acoustic.TIER, acoustic.run, audible=True),
    Tier(recovery.TIER, recovery.run),
)

TIER_NAMES = tuple(tier.name for tier in TIERS)
