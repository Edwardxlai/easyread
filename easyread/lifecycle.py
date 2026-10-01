"""浏览器页面的生命周期：最后一个页面关闭后留出导航缓冲，再退出服务。"""
from __future__ import annotations

import threading
import time


class PageSessions:
    def __init__(self, enabled: bool, grace: float = 8, startup_grace: float = 90, clock=time.monotonic):
        self.enabled = enabled
        self.grace = grace
        self.startup_grace = startup_grace
        self.clock = clock
        self.lock = threading.Lock()
        self.pages: dict[str, object] = {}
        self.empty_since = clock()
        self.seen_page = False
        self.stopping = False

    def open(self, page: str) -> object | None:
        with self.lock:
            if self.stopping:
                return None
            connection = object()
            self.pages[page] = connection
            self.seen_page = True
            return connection

    def connected(self, page: str, connection: object) -> bool:
        with self.lock:
            return not self.stopping and self.pages.get(page) is connection

    def close(self, page: str, connection: object | None = None):
        with self.lock:
            if page not in self.pages or (connection is not None and self.pages[page] is not connection):
                return
            del self.pages[page]
            if not self.pages:
                self.empty_since = self.clock()

    def expired(self) -> bool:
        with self.lock:
            delay = self.grace if self.seen_page else self.startup_grace
            if self.enabled and not self.stopping and not self.pages and self.clock() - self.empty_since >= delay:
                self.stopping = True  # 防止退出检测与新页面连接之间的竞争
                return True
            return False

    def stop(self):
        with self.lock:
            self.stopping = True
