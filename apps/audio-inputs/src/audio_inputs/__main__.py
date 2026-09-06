"""Entry point: `python3 -m audio_inputs --config ... --status ...`."""

from __future__ import annotations

import argparse
import logging
import os
import signal
from pathlib import Path

from .config import InputsConfig
from .daemon import AudioInputs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--status", type=Path, required=True)
    args = parser.parse_args()
    level = getattr(
        logging, os.environ.get("SMARTAMP_LOG_LEVEL", "info").upper(), logging.INFO
    )
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s")
    daemon = AudioInputs(InputsConfig.load(args.config), args.status)
    signal.signal(signal.SIGTERM, daemon.stop)
    signal.signal(signal.SIGINT, daemon.stop)
    return daemon.execute()


if __name__ == "__main__":
    raise SystemExit(main())
