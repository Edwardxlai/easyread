"""Monotonic wall-clock intervals for one translation job, including overlapping lanes."""
from __future__ import annotations

import threading
from contextlib import contextmanager, nullcontext
from time import perf_counter


class Timeline:
    def __init__(self):
        self.start = perf_counter()
        self.lock = threading.Lock()
        self.events = []

    @contextmanager
    def stage(self, name):
        start = perf_counter()
        ok = False
        try:
            yield
            ok = True
        finally:
            end = perf_counter()
            with self.lock:
                self.events.append({"stage": name, "start_s": round(start - self.start, 4),
                                    "end_s": round(end - self.start, 4), "ok": ok})

    def snapshot(self):
        with self.lock:
            return {"elapsed_s": round(perf_counter() - self.start, 4),
                    "events": sorted(self.events, key=lambda e: e["start_s"])}


def stage(meter, name):
    timeline = getattr(meter, "timing", None)
    return timeline.stage(name) if timeline is not None else nullcontext()


@contextmanager
def merge_lock(meter, lock):
    with stage(meter, "merge_wait"):
        lock.acquire()
    try:
        yield
    finally:
        lock.release()
