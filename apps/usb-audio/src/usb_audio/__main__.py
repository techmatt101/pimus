"""Entry point: python3 -m usb_audio --config ... --socket ... --status ..."""
import argparse
import logging
import os
import signal
from pathlib import Path
from .config import UsbConfig
from .daemon import UsbAudio


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--status", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, os.environ.get("SMARTAMP_LOG_LEVEL", "info").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    client = UsbAudio(UsbConfig.load(args.config), args.socket, args.status)
    signal.signal(signal.SIGTERM, client.stop)
    signal.signal(signal.SIGINT, client.stop)
    return client.execute()


if __name__ == "__main__":
    raise SystemExit(main())
