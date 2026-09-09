"""What the suite found, as lines for a terminal and as JSON for a script."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Outcome(str, Enum):
    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"
    SKIP = "SKIP"


@dataclass(frozen=True)
class Check:
    tier: str
    name: str
    outcome: Outcome
    detail: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "name": self.name,
            "outcome": self.outcome.value,
            "detail": self.detail,
        }


@dataclass
class Report:
    host: str
    checks: list[Check] = field(default_factory=lambda: [])

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        return check

    @property
    def failed(self) -> list[Check]:
        return [check for check in self.checks if check.outcome is Outcome.FAIL]

    @property
    def exit_code(self) -> int:
        return 1 if self.failed else 0

    def counts(self) -> dict[str, int]:
        return {
            outcome.value: sum(1 for check in self.checks if check.outcome is outcome)
            for outcome in Outcome
        }

    def render_text(self) -> str:
        lines: list[str] = []
        tier = None
        for check in self.checks:
            if check.tier != tier:
                tier = check.tier
                lines.append(f"\n== {tier} ==")
            detail = f": {check.detail}" if check.detail else ""
            lines.append(f"{check.outcome.value:<5} {check.name}{detail}")
        counts = self.counts()
        summary = ", ".join(f"{count} {name.lower()}" for name, count in counts.items())
        lines.append(f"\n{summary}")
        return "\n".join(lines).lstrip("\n")

    def to_json(self) -> dict[str, Any]:
        return {
            "host": self.host,
            "checks": [check.to_json() for check in self.checks],
            "counts": self.counts(),
            "ok": not self.failed,
        }

    def render_json(self) -> str:
        return json.dumps(self.to_json(), indent=2)
