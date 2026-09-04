"""Make a failed microphone worker visible to systemd's restart policy."""

from __future__ import annotations

import functools
import logging
import os
from typing import Any, Callable


LOG = logging.getLogger("smartamp")


def exit_on_capture_failure(worker: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(worker)
    def supervised(*args: Any, **kwargs: Any) -> Any:
        try:
            return worker(*args, **kwargs)
        except SystemExit as error:
            if error.code in (None, 0):
                raise
            LOG.critical(
                "Microphone worker exited; restarting voice assistant", exc_info=True
            )
        except Exception:
            LOG.critical(
                "Microphone worker failed; restarting voice assistant", exc_info=True
            )
        # sys.exit() here would terminate only the microphone thread.
        os._exit(1)

    return supervised
