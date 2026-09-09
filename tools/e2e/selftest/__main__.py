"""Entry point: `smartamp-selftest [options]` runs the tiers;
`smartamp-selftest observe <what>` watches for an outside stimulus."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from pathlib import Path

from .config import SelftestConfig
from .observe import OBSERVATIONS, observe
from .report import Check, Outcome, Report
from .runtime import Runtime
from .session import Options, Session
from .tiers import TIER_NAMES, TIERS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="smartamp-selftest")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    parser.add_argument("--silent", action="store_true", help="skip the audible tiers")
    parser.add_argument("--force", action="store_true",
                        help="test even while something is playing")
    parser.add_argument("--restart", action="store_true",
                        help="include the tier that restarts the daemons")
    parser.add_argument("--only", default="", help="comma-separated tiers to run")
    parser.add_argument("--skip", default="", help="comma-separated tiers to skip")
    parser.add_argument("--level", type=int, default=None,
                        help="music level for the acoustic tier")
    parser.add_argument("--min-rise-db", type=float, default=None,
                        help="how far the array must hear the speaker rise")
    subparsers = parser.add_subparsers(dest="mode")
    watch = subparsers.add_parser("observe", help="watch for an outside stimulus")
    watch.add_argument("what", choices=sorted(OBSERVATIONS))
    watch.add_argument("--seconds", type=float, default=15.0)
    watch.add_argument("--marker", default="")
    args = parser.parse_args(argv)

    config = SelftestConfig.load(args.config)
    if os.geteuid() not in (0, config.uid):
        print("smartamp-selftest must run as root (sudo) or as the service account", file=sys.stderr)
        return 2
    options = Options(
        silent=bool(args.silent),
        force=bool(args.force),
        restart=bool(args.restart),
        only=_names(args.only),
        skip=_names(args.skip),
        music_volume=args.level,
        min_rise_db=args.min_rise_db,
    )
    unknown = (options.only | options.skip) - set(TIER_NAMES)
    if unknown:
        parser.error(f"unknown tiers {sorted(unknown)}; choose from {', '.join(TIER_NAMES)}")

    report = Report(host=socket.gethostname())
    session = Session(config, Runtime(config), report, options)
    if args.mode == "observe":
        return _observe(session, str(args.what), float(args.seconds), str(args.marker))
    return _run(session, report, as_json=bool(args.json))


def _names(value: str) -> set[str]:
    return {name.strip() for name in value.split(",") if name.strip()}


def _run(session: Session, report: Report, *, as_json: bool) -> int:
    try:
        session.open()
    except OSError as error:
        report.add(Check("services", "audio manager socket", Outcome.FAIL,
                         f"{session.config.socket}: {error}"))
        _print(report, as_json)
        return report.exit_code
    try:
        for tier in TIERS:
            if session.options.only and tier.name not in session.options.only:
                continue
            if tier.name in session.options.skip:
                report.add(Check(tier.name, tier.name, Outcome.SKIP, "--skip"))
                continue
            try:
                tier.run(session)
            except Exception as error:  # noqa: BLE001 - one tier must not end the run
                report.add(Check(tier.name, f"{tier.name} tier", Outcome.FAIL,
                                 f"{type(error).__name__}: {error}"))
    finally:
        try:
            session.close()
        except Exception as error:  # noqa: BLE001
            report.add(Check("restore", "levels restored", Outcome.FAIL,
                             f"{type(error).__name__}: {error}"))
    _print(report, as_json)
    return report.exit_code


def _observe(session: Session, what: str, seconds: float, marker: str) -> int:
    session.open()
    try:
        result = observe(session, what, seconds, marker)
    finally:
        session.close()
    print(json.dumps(result))
    return 0


def _print(report: Report, as_json: bool) -> None:
    print(report.render_json() if as_json else report.render_text())


if __name__ == "__main__":
    raise SystemExit(main())
