#!/usr/bin/env python3
"""Sendspin's volume hook: move the amp's music level instead of its own gain.

Sendspin runs this with the effective volume (0-100) as the last argument
whenever Music Assistant commands one, and applies no gain of its own while a
hook is configured. Without it the player would scale its own samples, leaving
a hidden second gain under the music level the dial and the deck report: the
slider in Music Assistant would quietly disagree with every other reading of
how loud this room is.

A mute arrives as a plain 0 - the hook is told the effective volume only, and
Sendspin persists the logical level itself - so it lands as a music level of
zero rather than the amp's own volume mute, and unmuting restores the level
Music Assistant sends next.

Failing here fails the player's volume command, which is the honest outcome:
the level did not move. Exit quietly when the manager is simply not up yet.
"""

from __future__ import annotations

import json
import os
import socket
import sys


CONNECT_TIMEOUT_SECONDS = 2.0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: smartamp_set_music_volume.py <percent>", file=sys.stderr)
        return 2
    path = os.environ.get("SMARTAMP_AUDIO_SOCKET")
    if not path:
        print("SMARTAMP_AUDIO_SOCKET is not set", file=sys.stderr)
        return 2
    try:
        percent = int(round(float(argv[-1])))
    except ValueError:
        print(f"volume must be a number, got {argv[-1]!r}", file=sys.stderr)
        return 2
    percent = max(0, min(100, percent))

    command = json.dumps({"command": "set-music-volume", "percent": percent})
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(CONNECT_TIMEOUT_SECONDS)
            connection.connect(path)
            connection.sendall(f"{command}\n".encode("utf-8"))
    except (ConnectionRefusedError, FileNotFoundError):
        # The manager is restarting. Its own startup volume wins; saying so
        # would only turn a routine restart into a player error.
        print(f"audio manager socket {path} is not accepting commands", file=sys.stderr)
        return 0
    except OSError as error:
        print(f"could not set the music level: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
