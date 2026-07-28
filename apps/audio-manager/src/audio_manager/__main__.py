"""Entry point: `python3 -m audio_manager --config ... --socket ... --status ...`."""

from __future__ import annotations

import argparse
import logging
import os
import signal
from pathlib import Path

from .config import AudioConfig
from .daemon import AudioManager


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--status", type=Path, required=True)
    args = parser.parse_args()
    level = getattr(
        logging, os.environ.get("SMARTAMP_LOG_LEVEL", "info").upper(), logging.INFO
    )
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s")
    manager = AudioManager(AudioConfig.load(args.config), args.socket, args.status)
    signal.signal(signal.SIGTERM, manager.stop)
    signal.signal(signal.SIGINT, manager.stop)
    return manager.execute()


if __name__ == "__main__":
    raise SystemExit(main())
