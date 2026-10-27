"""本地服务：只监听 127.0.0.1。文献库页、阅读页、数据接口、导入、后台任务。"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading

from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from .. import __version__
from ..chat import answer_styles, chat, chat_models, chat_store, notehelp
from ..pdf import figures, pdfwork
from ..app import cli_models, config, i18n, open_link, prefs, updates
from ..engines import detect, engines, usage
from ..translate import langs
from ..library import trash
from . import settings_api, library_api, jobs_api, paper_api, wsock
from ..app.log import log, tail
from ..bulk import api as bulk_api
from .jobs import Jobs
from ..library.library import Library
from ..app.i18n import tr
from ..library.store import now_iso
from ..library.reader_files import prepare_later as _prepare_later

WEB = config.WEB
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
MAX_UPLOAD = 200 * 1024 * 1024


def _safe(base: Path, rel: str) -> Path | None:
    target = (base / rel).resolve()
    return target if target.is_relative_to(base.resolve()) and target.is_file() else None


class App:
    def __init__(self, cfg: dict):
        self.lib = Library(config.library_dir(cfg))
        self.jobs = Jobs(self.lib)
        self.token = os.urandom(12).hex()
        self.location = library_api.LibraryLocation(self)
        self.presence = None  # presence.Presence，serve() 里设


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---------- 输出 ----------
    def _send(self, code: int, body: bytes, ctype: str, cache: bool = False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _file(self, path: Path | None, cache=False, ctype=None):
        if not path:
            return self._json(404, {"error": "not found"})
        ctype = ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype, cache)

    def _redirect(self, location: str):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _page(self, path: Path):
        self._send(200, i18n.inject(path.read_text(encoding="utf-8")).encode("utf-8"), "text/html; charset=utf-8")

    def _download(self, body: bytes, filename: str, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f"attachment; filename=\"export.html\"; filename*=UTF-8''{quote(filename)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _chat(self, ws, body):
        from .chat_handler import handle
        return handle(self, ws, body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", "0"))
        if n > MAX_UPLOAD:
            raise ValueError(tr("文件太大"))
        return self.rfile.read(n) if n else b""

    def _import_result(self, ws, fresh, translate_after, scope, read=False, model="", target="", translation_extra=""):
        # A failed first preparation still leaves a library entry. Re-importing
        # that PDF must retry preparation instead of silently skipping it.
        paper = ws.load("paper") or {}
        active = (ws.load("job") or {}).get("state") in ("queued", "running")
        queued = fresh or (not paper.get("meta", {}).get("pages") and not active)
        if queued:
            if translate_after and not read:
                langs.remember(ws, target)  # 导入框里选的译文语言
            self.app.jobs.enqueue(ws, translate_after=translate_after, scope=scope, read=read, model=model, translation_extra=translation_extra)
        return self._json(200, {"id": ws.id, "new": fresh, "queued": queued})

    # ---------- GET ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            with self.app.location.request(self.command, self.path):
                self._get()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Back/close/timeout can cancel a read after headers are sent. The
            # client is gone; a second error response only raises again.
            self.close_connection = True
        except ValueError as e:
            self._json(409, {"error": str(e), "library_status": self.app.location.status})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _get(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        app, lib = self.app, self.app.lib
        if path in ("/", "/index.html"):
            return self._page(WEB / "library.html")
        if path == "/web/tabs.html":
            return self._page(WEB / "tabs.html")
        if path.startswith("/read/"):
            return self._page(WEB / "reader.html")
        if path == "/open":  # 外部工具打开指定论文/段落；桌面版的 easyread://open 也转到这里
            return self._redirect(open_link.target(lib, parse_qs(url.query)))
        if path == "/api/version":
            return self._json(200, open_link.version())
        if path.startswith("/web/"):
            return self._file(_safe(WEB, path[5:]), cache=path.startswith("/web/vendor/"))
        if path == "/api/presence" and wsock.is_upgrade(self.headers):
            return self._presence()
        location = library_api.get(app, path)
        if location is not None:
            return self._json(200, location)
        if path in bulk_api.GET:
            return self._json(200, bulk_api.get(app, path))
        if path == "/api/library":
            cfg = config.load()
            return self._json(200, {"items": lib.list(), "token": app.token, "jobs": app.jobs.small_status(),
                                    "library_status": app.location.status, "other_device": app.location.marker.other_device(),
                                    "engine": cfg.get("engine"), "engine_label": cli_models.engine_label(cfg),
                                    "first_run": config.is_first_run(), "version": __version__, "trash": len(trash.items(lib.root))})
        if path == "/api/update":  # 有没有新版本（一天最多问一次 GitHub）
            return self._json(200, updates.check(force=parse_qs(url.query).get("force") == ["1"]))
        if path == "/api/trash":
            return self._json(200, {"items": trash.items(lib.root)})
        if path == "/api/config":
            return self._json(200, {"config": config.public(config.load()), "presets": config.PRESETS, "groups": config.PRESET_GROUPS})
        if path == "/api/engines":
            cfg = config.load()
            found = detect.detect(cfg, fresh=parse_qs(url.query).get("fresh") == ["1"])
            return self._json(200, {"found": found, "ready": detect.ready(cfg, found), "engine": cfg.get("engine"), "models": cli_models.listing()})
        if path == "/api/prefs":
            return self._json(200, prefs.load())
        if path == "/api/chat/models":
            return self._json(200, chat_models.listing(config.load()))
        if path == "/api/log":
            return self._json(200, {"text": tail(config.LOG_PATH, 200), "path": str(config.LOG_PATH)})
        if path == "/api/jobs":
            return self._json(200, {"jobs": app.jobs.small_status(parse_qs(url.query).get("pid", [None])[0])})
        if path.startswith("/api/p/"):
            parts = path.split("/")  # ['', 'api', 'p', id, action, name?]
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": tr("没有这篇论文")})
            action = parts[4]
            if action == "state":
                opened = {"last_opened": now_iso()}
                if (ws.load("item") or {}).get("status", "unread") == "unread":  # 打开过就算在读
                    opened["status"] = "reading"
                if app.location.status == "idle":
                    ws.patch_item(opened)
                # Take versions before reading content: concurrent preparation
                # can then trigger a later poll, never tag old data as current.
                versions = ws.versions()
                cfg = config.load()
                state = {**{n: ws.load(n) for n in ("paper", "discussion", "reader", "layout", "item", "job")},
                         "versions": versions, "token": app.token, "id": ws.id, "library_status": app.location.status,
                         "engine": cfg.get("engine"), "figure_images_enabled": (cfg.get("figure_images") or {}).get("enabled") is True}
                self._json(200, state)
                # Existing layout is usable immediately. Upgrade only after the
                # response has been sent; polling picks up the new layout/crops.
                if app.location.status == "idle" and (state["job"] or {}).get("state") not in ("queued", "running"):
                    try:
                        _prepare_later(ws, app.location)
                    except Exception:  # noqa: BLE001
                        # The 200 response is already sent; do not append a 500
                        # response if migration or thread registration now fails.
                        log.exception("启动阅读页准备失败 %s", ws.root)
                return
            if action == "versions":
                return self._json(200, {**ws.versions(), "library_status": app.location.status,
                                        "figure_images_enabled": (config.load().get("figure_images") or {}).get("enabled") is True})
            if action == "chat":
                return self._json(200, {"threads": chat_store.threads(ws), **chat_models.listing(config.load()), "limits": usage.latest()})
            if action == "log":
                return self._json(200, {"text": tail(ws.root / "job.log", 300)})
            if action == "export":
                if app.location.status != "idle":
                    raise app.location._error()
                from ..export.build import build
                out = build(ws, mobile=parse_qs(url.query).get("mobile") == ["1"])
                return self._download(out.read_bytes(), out.name, "text/html; charset=utf-8")
            if action == "part" and len(parts) > 5 and parts[5] in ("paper", "discussion", "reader", "layout", "job"):
                version = ws.versions()[parts[5]]
                return self._json(200, {"data": ws.load(parts[5]), "version": version})
        if path.startswith("/p/"):
            _, _, pid, rel = path.split("/", 3)
            ws = lib.ws(pid)
            if ws and re.fullmatch(r"extract/page-[0-9]{3,6}\.chars\.json", rel):
                if parse_qs(url.query).get("selection") == ["2"]:
                    from ..pdf.selectable_text import page_file
                    return self._file(page_file(ws.root, ws.source_pdf, int(rel[13:-11])))
                return self._file(_safe(ws.root, rel), cache=True)
            if ws and app.location.status == "idle" and rel.startswith("pages/") and "w=" in url.query:  # 原页面板用的小一号图，第一次请求时生成
                try:
                    w = int(parse_qs(url.query)["w"][0])
                except (KeyError, IndexError, ValueError):
                    w = 1000
                variant = pdfwork.page_variant(ws.root, rel, w)
                return self._file(variant or _safe(ws.root, rel), cache=True)
            if ws and re.fullmatch(r"chat-media/[0-9a-f]{32}\.png", rel):
                return self._file(_safe(ws.root, rel), cache=True)
            if ws and (rel.split("/", 1)[0] in ("pages", "figures") or rel == "source.pdf"):
                source = ws.source_pdf if rel == "source.pdf" else _safe(ws.root, rel)
                return self._file(source if source and source.is_file() else None, cache=rel != "source.pdf",
                                  ctype="application/pdf" if rel == "source.pdf" else None)
        return self._json(404, {"error": "not found"})

    # ---------- POST ----------
    def do_POST(self):
        if self.headers.get("X-Token") != self.app.token:  # 挡住别的网页跨站写
            return self._json(403, {"error": "bad token"})
        try:
            with self.app.location.request("POST", self.path):
                self._post()
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _presence(self):
        """页面开着就一直连着这条 WebSocket；断开就是页面关了（见 presence.py）。"""
        host = self.headers.get("Host") or ""
        if self.headers.get("Origin") not in (None, f"http://{host}"):  # 别的网站不能来占着
            self.close_connection = True
            return self._json(403, {"error": "bad origin"})
        p = self.app.presence
        self.app.location.enter_page()
        try:
            wsock.accept(self)
            self.close_connection = True
            wsock.hold(self)
        finally:
            if p:
                p.leave()

    def _post(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        app, lib = self.app, self.app.lib

        if path in library_api.POST:
            return self._json(200, library_api.post(app, path, json.loads(self._body() or b"{}")))
        if path in jobs_api.POST:  # 一键停止翻译
            return self._json(200, jobs_api.post(app, path, json.loads(self._body() or b"{}")))
        if path in bulk_api.POST:  # 从 Zotero 迁移、导入文件夹
            return self._json(200, bulk_api.post(app, path, json.loads(self._body() or b"{}")))
        if path == "/api/update":  # 开关“自动检查新版本”
            config.save({"check_updates": bool(json.loads(self._body() or b"{}").get("enabled"))})
            return self._json(200, updates.check())
        if path == "/api/presence/keep":  # easyread serve 复用了关页会退出的服务：改成常驻
            if app.presence:
                app.presence.keep()
            return self._json(200, {"ok": True})
        if path == "/api/import":  # 请求体就是 PDF 文件
            data = self._body()
            ws, fresh = lib.create_from_pdf(data, q.get("name", "paper.pdf"))
            return self._import_result(ws, fresh, q.get("translate", "1") == "1", q.get("scope"),
                                       read=q.get("read") == "1", model=q.get("model", ""), target=q.get("target", ""), translation_extra=q.get("translation_extra", ""))
        if path in ("/api/import-url", "/api/import-arxiv"):
            body = json.loads(self._body() or b"{}")
            data, name, meta = lib.fetch(body.get("ref", ""))  # sources.SourceError 是 ValueError，回 400
            ws, fresh = lib.create_from_pdf(data, name, meta)
            return self._import_result(ws, fresh, bool(body.get("translate", True)), body.get("scope"),
                                       read=bool(body.get("read")), model=str(body.get("model") or ""), target=str(body.get("target") or ""), translation_extra=body.get("translation_extra", ""))
        if path in settings_api.POST:  # 设置页：保存配置、模型名单、试一下、取模型列表
            return self._json(200, settings_api.POST[path](json.loads(self._body() or b"{}")))
        if path == "/api/prefs":
            return self._json(200, prefs.save(json.loads(self._body() or b"{}")))
        if path == "/api/trash":  # 回收站：restore 恢复一篇 / purge 彻底删一篇 / empty 清空
            body = json.loads(self._body() or b"{}")
            act, name = body.get("action"), body.get("name", "")
            if act not in ("restore", "purge", "empty"):
                raise ValueError(tr("action 只能是 restore / purge / empty"))
            if act == "restore":
                return self._json(200, {"id": trash.restore(lib.root, name)})
            return self._json(200, {"deleted": trash.purge(lib.root, name) if act == "purge" else trash.empty(lib.root)})

        if path.startswith("/api/p/"):
            parts = path.split("/")
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": tr("没有这篇论文")})
            body = json.loads(self._body() or b"{}")
            if parts[4] == "chat" and len(parts) == 5:
                return self._chat(ws, body)
            if parts[4] == "notehelp":
                return notehelp.handle(self, ws, body)
            res = paper_api.post(app, ws, parts, body)
            if res is not None:
                return self._json(200, res)
        return self._json(404, {"error": "not found"})

