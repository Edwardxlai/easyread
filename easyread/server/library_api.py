"""云文献库接口与迁移写入闸门；切换后保持旧库只读，直到后端重启。"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from urllib.parse import unquote, urlparse

from ..library import cloudlib
from ..app import config
from ..library.cloudlib_lock import LibraryMarker
from ..app.i18n import tr


class LibraryLocation:
    def __init__(self, app):
        self.app = app
        self.lock = threading.RLock()
        self.active = 0
        self.status = "idle"
        self.marker = LibraryMarker(app.lib.root)

    def _error(self):
        return ValueError(tr("文献库正在迁移，请稍后再试") if self.status == "moving"
                          else tr("文献库位置已更改，请重启 EasyRead 后再修改"))

    def begin(self):
        with self.lock:
            if self.status != "idle":
                raise self._error()
            self.active += 1

    def end(self):
        with self.lock:
            self.active -= 1

    @contextmanager
    def request(self, method: str, raw_path: str):
        path = unquote(urlparse(raw_path).path)
        protected = (method == "POST" and path not in (
            "/api/library/move", "/api/library/inspect", "/api/library/pick-folder", "/api/library/reveal", "/api/shutdown", "/api/presence/keep"))
        if method in ("GET", "HEAD"):
            protected = path.startswith(("/read/", "/p/")) or (path.startswith("/api/p/") and not path.endswith("/versions"))
        entered = False
        if protected:
            with self.lock:
                # 重启前阅读接口继续提供只读数据；_get 不再做 state/图片的惰性写入。
                if self.status == "restart_required" and method in ("GET", "HEAD"):
                    protected = False
                else:
                    self.begin()
                    entered = True
        try:
            yield
        finally:
            if entered:
                self.end()

    def enter_page(self):
        with self.lock:
            if self.status == "moving":
                raise self._error()
            if self.app.presence:
                self.app.presence.enter()

    def _busy(self):
        # Jobs.bulk.get() 与登记 cancels 之间有短暂空档；持久 job 状态也必须核对。
        mig = getattr(self.app, "bulk", None)  # 正在从 Zotero 迁移或导入文件夹
        babeldoc = getattr(self.app, "babeldoc", None)
        return self.app.jobs.busy() or bool(babeldoc and babeldoc.running) or bool(mig and mig.busy()) or any((ws.load("job") or {}).get("state") in ("queued", "running")
                                           for ws in self.app.lib.all())

    def move(self, body: dict) -> dict:
        with self.lock:
            if self.status != "idle":
                raise self._error()
            if config.temp_library():
                raise ValueError(tr("临时文献库不能更改位置"))
            if self._busy():
                raise ValueError(tr("还有翻译或 AI 任务在运行，请等任务结束再更改文献库位置"))
            presence = self.app.presence
            if presence:
                with presence.lock:
                    if presence.pages > 1:
                        raise ValueError(tr("请先保存并关闭其他阅读页或文献库窗口，再更改文献库位置"))
            if self.active:
                raise ValueError(tr("文献库仍在保存或生成页面，请稍后再试"))
            self.status = "moving"
        try:
            result = cloudlib.move(self.app.lib.root, body.get("path", ""), body.get("mode", ""))
            with self.lock:
                self.status = "restart_required"
            return result
        finally:
            with self.lock:
                if self.status == "moving":
                    self.status = "idle"

    def location(self) -> dict:
        current = cloudlib.inspect(self.app.lib.root, exact=True)
        candidates = []
        for candidate in cloudlib.detect():
            try:
                candidates.append({**candidate, **cloudlib.inspect(candidate["path"])})
            except cloudlib.Incomplete as e:
                candidates.append({**candidate, **incomplete(e)})
            except (ValueError, OSError):
                continue
        return {**current, "path": str(self.app.lib.root), "temp": config.temp_library(), "candidates": candidates,
                "library_status": self.status, "moving": self.status == "moving",
                "restart_required": self.status == "restart_required"}

    def shutdown(self):
        with self.lock:
            if self.status == "moving" or self.active or self._busy():
                raise ValueError(tr("文献库仍有操作未完成，请稍后再重启"))
            self.status = "restart_required"
            stop = getattr(self.app, "shutdown", None)
            if not stop:
                raise ValueError(tr("当前服务无法自动重启，请关闭后重新打开"))
            self.marker.close()
            threading.Thread(target=stop, daemon=True).start()
        return {"ok": True}


def incomplete(e: "cloudlib.Incomplete") -> dict:
    """没搬完的目标：不报错，交给页面显示“清理”按钮。"""
    return {"path": e.path, "exists": True, "writable": False, "papers": 0, "bytes": 0, "incomplete": str(e)}


def inspect(body: dict) -> dict:
    try:
        return cloudlib.inspect(body.get("path", ""))
    except cloudlib.Incomplete as e:
        return incomplete(e)


def get(app, path: str):
    if path == "/api/library/location":
        return app.location.location()
    return None


def post(app, path: str, body: dict):
    if path == "/api/library/inspect":
        return inspect(body)
    if path == "/api/library/pick-folder":  # 浏览器版：后端弹系统的选文件夹窗口
        from ..app.folder_pick import pick
        chosen = pick(str(body.get("title") or "")[:100] or tr("选择放文献库的文件夹"))  # 迁移 Zotero、导入文件夹也用它
        return {"supported": chosen is not None, "path": chosen or ""}
    if path == "/api/library/cleanup":
        return cloudlib.cleanup(body.get("path", ""), app.lib.root)
    if path == "/api/library/move":
        return app.location.move(body)
    if path == "/api/library/reveal":
        from ..library.reader_files import reveal
        reveal(app.lib.root)
        return {"ok": True}
    if path == "/api/shutdown":
        return app.location.shutdown()
    return None


POST = {"/api/library/inspect", "/api/library/pick-folder", "/api/library/cleanup", "/api/library/move", "/api/library/reveal", "/api/shutdown"}
