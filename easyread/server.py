"""本地服务：只监听 127.0.0.1。文献库页、阅读页、数据接口、导入、后台任务。"""
from __future__ import annotations

import json
import mimetypes
import os
import sys
import threading

import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import __version__, chat, chat_models, chat_store, cli_models, config, detect, engines, notehelp, paperdata, pdfwork, prefs, settings_api, trash
from .log import log, setup as setup_log, tail
from .jobs import Jobs
from .library import Library
from .store import now_iso, write_json_atomic

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

    def _file(self, path: Path | None, cache=False):
        if not path:
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype, cache)

    def _download(self, body: bytes, filename: str, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f"attachment; filename=\"export.html\"; filename*=UTF-8''{quote(filename)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _chat(self, ws, body: dict):
        """流式回答：一行一个 JSON，{"t": 片段} … 最后 {"done": true, "id": …} 或 {"error": …}。"""
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError("问题是空的")
        cfg = config.load()
        ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
        model = chat_models.label(m)
        thread = chat_store.get(ws, body.get("thread"))
        tid = thread["id"] if thread else chat_store.new_id()
        refs = [{"anchor": str(r.get("anchor") or ""), "quote": str(r.get("quote") or "")[:1000]}
                for r in (body.get("refs") or [])[:12] if isinstance(r, dict) and r.get("anchor")]
        first = refs[0] if refs else {}
        user = {"content": text, "anchor": body.get("anchor") or first.get("anchor"), "quote": (body.get("quote") or first.get("quote") or "")[:1000],
                "note": body.get("note"), "refs": refs}
        past = (thread or {}).get("messages", [])
        convo = [{"role": x["role"], "content": x["content"]} for x in past] + [{"role": "user", "content": text}]
        prompt_text = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cancel = threading.Event()
        pieces: list[str] = []

        def send(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        try:
            send({"model": model, "thread": tid})
            def seen(actual):
                chat_models.remember(m.get("model", ""), actual)
                if m.get("engine") == "claude":
                    send({"model": chat_models.label(m)})
            for piece in chat.stream(ecfg, prompt_text, ws.root, cancel, seen):
                pieces.append(piece)
                send({"t": piece})
            msg = chat_store.append(ws, tid, user, "".join(pieces), m["id"], model)
            send({"done": True, "id": msg["id"]})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            cancel.set()  # 读者点了停止或关了页面
            if pieces:
                chat_store.append(ws, tid, {**user, "note": None}, "".join(pieces) + "\n\n（已停止）", m["id"], model)
        except engines.Cancelled:
            pass
        except Exception as e:  # noqa: BLE001
            log.exception("对话出错 %s", ws.id)
            try:
                send({"error": str(e)[:500]})
            except OSError:
                pass

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", "0"))
        if n > MAX_UPLOAD:
            raise ValueError("文件太大")
        return self.rfile.read(n) if n else b""

    # ---------- GET ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            self._get()
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _get(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        app, lib = self.app, self.app.lib
        if path in ("/", "/index.html"):
            return self._file(WEB / "library.html")
        if path.startswith("/read/"):
            return self._file(WEB / "reader.html")
        if path.startswith("/web/"):
            return self._file(_safe(WEB, path[5:]), cache=path.startswith("/web/vendor/"))
        if path == "/api/library":
            cfg = config.load()
            return self._json(200, {"items": lib.list(), "token": app.token, "jobs": app.jobs.small_status(),
                                    "engine": cfg.get("engine"), "engine_label": _engine_label(cfg),
                                    "first_run": config.is_first_run(), "version": __version__, "trash": len(trash.items(lib.root))})
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
                return self._json(404, {"error": "没有这篇论文"})
            action = parts[4]
            if action == "state":
                opened = {"last_opened": now_iso()}
                if (ws.load("item") or {}).get("status", "unread") == "unread":  # 打开过就算在读
                    opened["status"] = "reading"
                ws.patch_item(opened)
                _warm(ws.root)
                return self._json(200, {
                    **{n: ws.load(n) for n in ("paper", "discussion", "reader", "layout", "item", "job")},
                    "versions": ws.versions(), "token": app.token, "id": ws.id,
                    "engine": config.load().get("engine")})
            if action == "versions":
                return self._json(200, ws.versions())
            if action == "chat":
                return self._json(200, {"threads": chat_store.threads(ws), **chat_models.listing(config.load())})
            if action == "log":
                return self._json(200, {"text": tail(ws.root / "job.log", 300)})
            if action == "export":
                from .build import build
                out = build(ws)
                return self._download(out.read_bytes(), out.name, "text/html; charset=utf-8")
            if action == "part" and len(parts) > 5 and parts[5] in ("paper", "discussion", "reader", "layout", "job"):
                return self._json(200, {"data": ws.load(parts[5]), "version": ws.versions()[parts[5]]})
        if path.startswith("/p/"):
            _, _, pid, rel = path.split("/", 3)
            ws = lib.ws(pid)
            if ws and rel.startswith("pages/") and "w=" in url.query:  # 原页面板用的小一号图，第一次请求时生成
                try:
                    w = int(parse_qs(url.query)["w"][0])
                except (KeyError, IndexError, ValueError):
                    w = 1000
                variant = pdfwork.page_variant(ws.root, rel, w)
                return self._file(variant or _safe(ws.root, rel), cache=True)
            if ws and (rel.split("/", 1)[0] in ("pages", "figures") or rel == "source.pdf"):
                return self._file(_safe(ws.root, rel), cache=rel != "source.pdf")
        return self._json(404, {"error": "not found"})

    # ---------- POST ----------
    def do_POST(self):
        if self.headers.get("X-Token") != self.app.token:  # 挡住别的网页跨站写
            return self._json(403, {"error": "bad token"})
        try:
            self._post()
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _post(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        app, lib = self.app, self.app.lib

        if path == "/api/import":  # 请求体就是 PDF 文件
            data = self._body()
            ws, fresh = lib.create_from_pdf(data, q.get("name", "paper.pdf"))
            if fresh:
                app.jobs.enqueue(ws, translate_after=q.get("translate", "1") == "1", scope=q.get("scope"))
            return self._json(200, {"id": ws.id, "new": fresh})
        if path in ("/api/import-url", "/api/import-arxiv"):
            body = json.loads(self._body() or b"{}")
            data, name, meta = lib.fetch(body.get("ref", ""))  # sources.SourceError 是 ValueError，回 400
            ws, fresh = lib.create_from_pdf(data, name, meta)
            if fresh:
                app.jobs.enqueue(ws, translate_after=bool(body.get("translate", True)), scope=body.get("scope"))
            return self._json(200, {"id": ws.id, "new": fresh})
        if path in settings_api.POST:  # 设置页：保存配置、模型名单、试一下、取模型列表
            return self._json(200, settings_api.POST[path](json.loads(self._body() or b"{}")))
        if path == "/api/prefs":
            return self._json(200, prefs.save(json.loads(self._body() or b"{}")))
        if path == "/api/trash":  # 回收站：restore 恢复一篇 / purge 彻底删一篇 / empty 清空
            body = json.loads(self._body() or b"{}")
            act, name = body.get("action"), body.get("name", "")
            if act not in ("restore", "purge", "empty"):
                raise ValueError("action 只能是 restore / purge / empty")
            if act == "restore":
                return self._json(200, {"id": trash.restore(lib.root, name)})
            return self._json(200, {"deleted": trash.purge(lib.root, name) if act == "purge" else trash.empty(lib.root)})

        if path.startswith("/api/p/"):
            parts = path.split("/")
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": "没有这篇论文"})
            action = parts[4]
            body = json.loads(self._body() or b"{}")
            if action == "chat" and len(parts) > 5:
                sub, tid = parts[5], body.get("thread", "")
                if sub == "pin":
                    chat_store.pin(ws, tid, body.get("id", ""))
                elif sub == "rename":
                    chat_store.rename(ws, tid, body.get("title", ""))
                elif sub == "delete":
                    chat_store.delete(ws, tid)
                return self._json(200, {"threads": chat_store.threads(ws)})
            if action == "chat":
                return self._chat(ws, body)
            if action == "notehelp":
                return notehelp.handle(self, ws, body)
            if action == "discussion_del":
                return self._json(200, {"deleted": paperdata.delete_discussion(ws, str(body.get("id", "")))})
            if action == "ops":
                ops = body.get("ops") or []
                if not isinstance(ops, list):
                    raise ValueError("ops 必须是数组")
                res = ws.apply_reader_ops(ops, client=str(body.get("client", ""))[:40])
                res["versions"] = ws.versions()
                return self._json(200, res)
            if action == "item":
                return self._json(200, ws.patch_item(body))
            if action == "translate":
                pages = paperdata.parse_pages(body["pages"]) if body.get("pages") else None
                if body.get("failed"):  # 只重试上次没译成功的页
                    pages = sorted(int(k) for k in ((ws.load("job") or {}).get("failed") or {})) or None
                app.jobs.enqueue(ws, pages=pages, translate_after=True, scope=body.get("scope"))
                return self._json(200, {"ok": True})
            if action == "reveal":  # 在资源管理器 / 访达里打开这篇的文件夹
                _reveal(ws.root)
                return self._json(200, {"ok": True})
            if action == "cancel":
                app.jobs.cancel(ws.id)
                return self._json(200, {"ok": True})
            if action == "answer":
                return self._json(200, app.jobs.submit_small("answer", ws.id, note=body["note"]))
            if action == "retranslate":
                return self._json(200, app.jobs.submit_small("retranslate", ws.id, key=body["key"], hint=body.get("hint", "")))
            if action == "delete":
                app.jobs.cancel(ws.id)
                return self._json(200, {"trash": str(lib.trash(ws.id))})
        return self._json(404, {"error": "not found"})


_warming: set[str] = set()


def _warm(root: Path) -> None:
    """打开一篇论文时，后台生成原页面板用的小图（每篇只做一次）。"""
    if str(root) in _warming or (root / "pages" / f"w{pdfwork.PANEL_WIDTH}").exists() and \
            len(list((root / "pages" / f"w{pdfwork.PANEL_WIDTH}").glob("*.webp"))) >= len(list((root / "pages").glob("page-*.webp"))):
        return
    _warming.add(str(root))

    def run():
        try:
            pdfwork.warm_variants(root)
        except Exception:  # noqa: BLE001
            log.exception("生成面板图失败 %s", root)
        finally:
            _warming.discard(str(root))
    threading.Thread(target=run, daemon=True).start()


def _engine_label(cfg: dict) -> str:
    e = cfg.get("engine")
    if e == "openai":
        preset = next((p["name"] for p in config.PRESETS if p["id"] == cfg["openai"].get("preset")), "API")
        return f"{preset.split('（')[0]} · {cfg['openai'].get('model') or '未填模型'}"
    name = engines.ENGINE_NAMES.get(e, e or "")
    if e == "claude":  # 带上实际用的模型：Claude Code · Claude Opus 5.5
        m = cfg["claude"].get("model") or ""
        actual = chat_models.actual_of(m) if m else ""
        model = chat_models.pretty(actual) if actual else ("Claude " + m.capitalize() if m in ("opus", "sonnet", "haiku") else m) if m else cli_models.claude_default()
    elif e == "codex":
        model = chat_models.label({"engine": "codex", "model": cfg["codex"].get("model") or ""})
    else:
        model = ""
    return f"{name} · {model}" if model and model != "GPT" else name


def _reveal(path: Path):
    import subprocess
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


class _Server(ThreadingHTTPServer):
    # Windows 上 SO_REUSEADDR 会让两个进程同时占住 8765，浏览器随机连到其中一个（比如旧版本）
    allow_reuse_address = os.name != "nt"


def serve(port: int | None = None, open_browser: bool = False, path: str = "/"):
    setup_log(config.LOG_PATH)
    cfg = config.load()
    app = App(cfg)
    Handler.app = app
    detect.warm(cfg)
    port = cfg["port"] if port is None else port
    try:
        httpd = _Server(("127.0.0.1", port), Handler)
    except OSError:
        httpd = _Server(("127.0.0.1", 0), Handler)
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    if not config.temp_library():
        write_json_atomic(config.SERVER_INFO, {"url": url, "pid": os.getpid(), "started": now_iso()})
    log.info("EasyRead %s 已启动：%s  文献库：%s", __version__, url, app.lib.root)
    print(f"EasyRead 已启动：{url}  文献库：{app.lib.root}", flush=True)
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url + path)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
