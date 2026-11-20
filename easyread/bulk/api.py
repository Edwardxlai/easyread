"""成批导入的接口：找 Zotero 数据目录；看一眼有多少、开始 / 停止、查进度（Zotero 和文件夹共用）。"""
from __future__ import annotations

from ..zotero import locate
from .runner import Migration


def _mig(app) -> Migration:
    if not getattr(app, "bulk", None):
        app.bulk = Migration(app)
    return app.bulk


def get(app, path: str):
    if path == "/api/zotero/detect":
        return {"candidates": locate.candidates()}
    if path == "/api/migrate/status":
        return _mig(app).status
    return None


def post(app, path: str, body: dict):
    source, where, base = str(body.get("source") or "zotero"), str(body.get("path") or ""), str(body.get("base") or "")
    if path == "/api/migrate/scan":
        result = _mig(app).scan(source, where, base)
        if source == "folder":
            result["watch"] = app.folder_watch.options(result["path"])
        return result
    if path == "/api/migrate/watch":
        app.folder_watch.configure(where, body.get("enabled") is True, body.get("link") is True,
                                   body.get("keep_filename") is True)
        return {"ok": True}
    if path == "/api/migrate/start":
        return _mig(app).start(source, where, base, with_tags=body.get("tags", True) is not False,
                               fetch=body.get("fetch") is True, link=body.get("link") is True,
                               keep_filename=source == "folder" and body.get("keep_filename") is True)
    if path == "/api/migrate/stop":
        return _mig(app).stop()
    return None


GET = {"/api/zotero/detect", "/api/migrate/status"}
POST = {"/api/migrate/watch", "/api/migrate/scan", "/api/migrate/start", "/api/migrate/stop"}
