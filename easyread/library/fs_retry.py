"""Bounded retries for transient Windows filesystem/filter-driver failures."""
import errno
import os
import time


def retry_write(operation):
    for attempt in range(5):
        try:
            return operation()
        except OSError as error:
            # A Windows lock file pending deletion can make O_EXCL return EACCES
            # without a winerror. Retry the exclusive operation with the same bounds.
            transient = os.name == "nt" and (
                error.errno in (errno.EINVAL, errno.EACCES) or getattr(error, "winerror", None) in (32, 33))
            if not transient or attempt == 4:
                raise
            time.sleep(.05 * (attempt + 1))
