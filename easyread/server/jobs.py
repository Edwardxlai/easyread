"""后台任务：导入后的渲染与整篇翻译（一条队列，状态落在每篇的 job.json，重启后接着做），
以及“让模型回答我的问题 / 重译这段”这类小任务（另一条队列，不用等整篇翻译）。"""
from __future__ import annotations

import queue
import threading
import time
from uuid import uuid4

from ..chat import chat_models
from ..app import config
from ..translate import langs, translate, instructions
from ..engines import usage
from ..engines.engines import Cancelled, EngineError
from ..app.i18n import tr
from ..library.library import Library
from ..app.log import log
from ..library.store import DataReadError, Workspace, now_iso
from .paper_workers import worker_count


def engine_for(cfg: dict, model: str | None) -> dict:
    """导入时选了“问 AI”名单里的模型就用它，否则用设置里的翻译引擎。名单里已经没有这个模型了，也用翻译引擎。"""
    m = next((x for x in chat_models.models(cfg) if x.get("id") == model), None) if model else None
    if not m:
        return cfg
    out, _ = chat_models.engine_cfg(cfg, model)
    o = cfg.get("openai") or {}
    if m["engine"] == "openai" and m.get("preset") == o.get("preset") and (m.get("model") or o.get("model")) == o.get("model"):
        out["openai"]["vision"] = o.get("vision", False)  # 和翻译引擎是同一个模型：沿用“模型能看图”
    return out


class Jobs:
    def __init__(self, lib: Library):
        self.lib = lib
        self.bulk: queue.Queue[str] = queue.Queue()
        self.small: queue.Queue[dict] = queue.Queue()
        self.cancels: dict[str, threading.Event] = {}
        self.recent: list[dict] = []  # 小任务的状态，给页面轮询
        self.lock = threading.Lock()
        self._resume()
        threading.Thread(target=self._small_loop, daemon=True).start()
        for _ in range(worker_count(config.load())):
            threading.Thread(target=self._bulk_loop, daemon=True).start()

    # ---------- 整篇 ----------
    def _write(self, ws: Workspace, **fields):
        def apply(job):
            job.update(fields)
            job["updated"] = now_iso()
        try:
            ws.update("job", apply)
        except FileNotFoundError:
            # 删除会把整篇目录移到回收站；收尾时不再向旧路径写状态，也不重建目录。
            if ws.root.exists():
                raise

    def enqueue(self, ws: Workspace, pages: list[int] | None = None, translate_after: bool = True, scope: str | None = None,
                read: bool = False, model: str = "", confirmed: bool = False, target: str = "", cap_check: bool = False,
                translation_extra: str = ""):
        """pages=None：按 scope（all / body / range:A-B / first:N）翻译还没译的页。
        read：只读原文，用模型把页整理成段落、公式、表格，不翻译；之后再翻译时就地补中文。
        model：用“问 AI”名单里的哪个模型（导入时选的）；空着用设置里的翻译引擎。
        confirmed：只接受真正的 True；target：续跑时保留原任务的译文语言。
        cap_check：pages 来自系统计划而非用户指定，仍检查页数上限并跳过已完成页。"""
        target = langs.valid(target) if target else langs.of_paper((ws.load("paper") or {}).get("meta"))
        translation_extra = instructions.validate(translation_extra)
        def apply(job):
            if job.get("state") in ("queued", "running"):
                raise ValueError(tr("这篇论文已有任务在排队或运行，请等它结束，或先取消再重试。"))
            job.update(type="read" if read and translate_after else "translate" if translate_after else "prepare",
                       state="queued", message=tr("排队中"), pages=pages, scope=scope or "all", translate=translate_after, read=read, model=model or "",
                       confirmed=confirmed is True, target=target, cap_check=cap_check is True, translation_extra=translation_extra,
                       done=0, total=0, error="", failed={}, updated=now_iso(), usage={})
            job.pop("page_cap", None)
        with self.lock:
            ws.update("job", apply)
            self.bulk.put(ws.id)

    def cancel(self, pid: str):
        with self.lock:
            ev = self.cancels.get(pid)
            if ev:
                ev.set()
            ws = self.lib.ws(pid)
            job = (ws.load("job") or {}) if ws else {}
            if job.get("state") == "queued":
                self._write(ws, state="cancelled", message=tr("已取消"))
            elif job.get("state") == "confirm":
                self._write(ws, state="done", message=tr("已导入，未整理") if job.get("read") else tr("已导入，未翻译"))

    def enqueue_figures(self, ws: Workspace, body: dict):
        from . import figure_jobs
        if not (config.load().get("figure_images") or {}).get("enabled"):
            raise ValueError(tr("请先在设置中开启生成译图"))
        ids = figure_jobs.select(ws, body)

        def apply(job):
            if job.get("state") in ("queued", "running"):
                raise ValueError(tr("这篇论文已有任务在排队或运行，请等它结束，或先取消再重试。"))
            job.update(type="figure-images", state="queued", message=tr("译图排队中"),
                       figure_ids=ids, force=body.get("force", False), translate=True, read=False,
                       model="", target="", translation_extra="", done=0, total=len(ids),
                       error="", failed={}, image_failed={}, updated=now_iso(), usage={})
        with self.lock:
            ws.update("job", apply)
            self.bulk.put(ws.id)
        return {"ok": True, "count": len(ids)}

    def stop_model_work(self, ids: list[str] | None = None) -> int:
        """一键停止：只停用模型的部分（翻译、整理原文、等确认页数的），原页照样渲染。
        还在排队、原页没渲染的改成只渲染；ids 为空就是全部。返回停了几篇。"""
        want = set(ids) if ids is not None else None
        n = 0
        with self.lock:
            for ws in self.lib.all():
                if want is not None and ws.id not in want:
                    continue
                job = ws.load("job") or {}
                state = job.get("state")
                if state not in ("queued", "running", "confirm") or not job.get("translate"):
                    continue
                n += 1
                if state == "running":
                    ev = self.cancels.get(ws.id)
                    if ev:
                        ev.set()
                elif state == "confirm":
                    self._write(ws, state="done", message=tr("已导入，未整理") if job.get("read") else tr("已导入，未翻译"))
                elif job.get("type") == "figure-images" or (ws.load("paper") or {}).get("meta", {}).get("pages"):
                    self._write(ws, state="cancelled", message=tr("已取消"))
                else:  # 留在队里，轮到时只渲染原页
                    self._write(ws, type="prepare", translate=False, read=False, message=tr("排队中"))
        return n

    def _resume(self):
        for ws in self.lib.all():
            try:
                job = ws.load("job") or {}
            except DataReadError as e:
                # Preserve unreadable state for recovery; other papers can still resume.
                log.exception("Cannot resume task; unreadable data file: %s", e.path)
                continue
            if job.get("state") in ("queued", "running"):
                if job.get("type") == "figure-images" and job.get("state") == "running":
                    self._write(ws, state="cancelled", message=tr("译图任务因服务重启而中断，已保存的图片保留；可手动补齐"))
                    continue  # An in-flight generation may have consumed quota; never blindly repeat it.
                self._write(ws, state="queued", message=tr("排队中（服务重启后继续）"))
                self.bulk.put(ws.id)

    def _bulk_loop(self):
        while True:
            pid = self.bulk.get()
            try:
                self._process_bulk(pid)
            except Exception:  # noqa: BLE001
                # 启动或收尾（包括写错误状态）也可能失败，不能让一篇论文停掉整条队列。
                log.exception("后台任务出错 %s", pid)

    def _process_bulk(self, pid: str):
        with self.lock:
            ws = self.lib.ws(pid)
            if not ws:
                return
            job = ws.load("job") or {}
            if job.get("state") != "queued":
                return
            cancel = self.cancels[pid] = threading.Event()
            try:
                self._write(ws, state="running", message=tr("正在开始任务"))
            except Exception:
                self.cancels.pop(pid, None)
                raise
        try:
            self._run_bulk(ws, job, cancel)
        except Cancelled:
            self._write(ws, state="cancelled", message=tr("已取消，已译的部分保留"))
        except Exception as e:  # noqa: BLE001
            if cancel.is_set():  # 点了停止后模型调用被打断而报错：算取消，不算出错
                self._write(ws, state="cancelled", message=tr("已取消，已译的部分保留"))
                return
            msg = str(e) if isinstance(e, (EngineError, KeyError, ValueError)) else f"{type(e).__name__}: {e}"
            self._write(ws, state="error", message=tr("出错了"), error=msg[:800])
            log.exception("后台任务出错 %s", pid)
            try:
                translate.journal(ws, tr("出错停止：{msg}", msg=msg[:500]))
            except OSError:
                pass
        finally:
            with self.lock:
                # An immediate retry may already have registered its own event.
                if self.cancels.get(pid) is cancel:
                    self.cancels.pop(pid, None)

    def _run_bulk(self, ws: Workspace, job: dict, cancel: threading.Event):
        if job.get("type") == "figure-images":
            from . import figure_jobs
            return figure_jobs.run(self, ws, job, config.load(), cancel)
        cfg = engine_for(config.load(), job.get("model"))
        cfg = {**cfg, "translation_extra": job.get("translation_extra", "")}
        if job.get("target"):
            cfg = {**cfg, "target": langs.valid(job["target"])}
        if cancel.is_set():
            raise Cancelled()
        if not ws.load("paper").get("meta", {}).get("pages"):
            self._write(ws, state="running", message=tr("正在渲染原页、抽取文字"))
            translate.prepare(ws)
        if cancel.is_set():
            raise Cancelled()
        read = bool(job.get("read"))
        if not job.get("translate") or cfg.get("engine") == "none":
            self._write(ws, state="done", message=tr("已导入（没有可用的模型，先放原页）") if read else tr("已导入（未开启自动翻译）") if job.get("translate") else tr("已导入"))
            return
        paper = ws.load("paper")
        all_pages = [p["n"] for p in paper["meta"]["pages"]]
        tl = paper.get("translation", {})
        # 只读原文：跳过已经整理过（或已经译过）的页；翻译：跳过已经有译文的页，只有原文的页会补译文
        skip = set(tl.get("done_pages", [])) if read else set(tl.get("done_pages", [])) - set(tl.get("en_pages", []))
        planned = job.get("pages") is not None
        wanted = job["pages"] if planned else translate.scope_pages(ws, job.get("scope")) or all_pages
        pages = wanted if planned and not job.get("cap_check") else [n for n in wanted if n not in skip]
        if not pages:
            self._write(ws, state="done", message=tr("选定范围已整理完") if read else tr("选定范围已译完"))
            return

        cap = cfg.get("page_cap", 60)
        if type(cap) is not int or cap < 0:
            cap = 60  # 手改配置写错时仍按默认上限保护，不把错误值当作不限。
        check_cap = job.get("cap_check") or (not planned and (job.get("scope") or "all") in ("all", "body"))
        if cap > 0 and len(pages) > cap and check_cap and job.get("confirmed") is not True:
            with self.lock:
                if cancel.is_set():
                    raise Cancelled()
                self._write(ws, state="confirm", total=len(pages), page_cap=cap, pages=pages, cap_check=True,
                            message=tr("这篇要整理 {n} 页，超过了你设的 {cap} 页，确认后再开始", n=len(pages), cap=cap) if read
                            else tr("这篇要译 {n} 页，超过了你设的 {cap} 页，确认后再开始", n=len(pages), cap=cap))
            return

        meter = usage.Meter(cfg.get("engine") or "")

        def report(done, total, message):
            if cancel.is_set():
                raise Cancelled()
            self._write(ws, state="running", done=done, total=total, message=message, usage=meter.snapshot())

        started = time.time()
        try:
            failed = translate.translate_pages(ws, cfg, pages, cancel, report, meter, read)
        finally:  # 取消、出错也把已经花掉的记上
            run = meter.snapshot()
            if run["calls"]:
                ws.update("job", lambda j: j.update(usage=run, usage_total=usage.merge(j.get("usage_total"), run)))
        minutes = max(1, round((time.time() - started) / 60))
        if failed:
            first = next(iter(failed.values()))
            self._write(ws, state="partial", failed={str(k): v for k, v in failed.items()}, error=first,
                        message=(tr("{ok} 页好了，", ok=len(pages) - len(failed)) if len(failed) < len(pages) else "")
                        + (tr("{n} 页没整理成功", n=len(failed)) if read else tr("{n} 页没译成功", n=len(failed))))
        else:
            self._write(ws, state="done", failed={}, error="",
                        message=tr("原文整理完成（{n} 页，用时约 {m} 分钟）", n=len(pages), m=minutes) if read
                        else tr("翻译完成（{n} 页，用时约 {m} 分钟）", n=len(pages), m=minutes))

    # ---------- 小任务 ----------
    def submit_small(self, kind: str, pid: str, **kw) -> dict:
        job = {"id": "j" + uuid4().hex, "kind": kind, "pid": pid, "state": "queued", "message": tr("排队中"),
               "at": now_iso(), **kw}
        with self.lock:
            self.recent = ([job] + self.recent)[:50]
        self.small.put(job)
        return job

    def small_status(self, pid: str | None = None) -> list[dict]:
        with self.lock:
            return [dict(j) for j in self.recent if not pid or j["pid"] == pid]

    def busy(self) -> bool:
        """还有整篇翻译或小任务没做完（关页自动退出时要等它们）。"""
        if self.cancels or not self.bulk.empty() or not self.small.empty():
            return True
        with self.lock:
            return any(j["state"] in ("queued", "running") for j in self.recent)

    def _small_loop(self):
        while True:
            job = self.small.get()
            ws = self.lib.ws(job["pid"])
            if not ws:
                job["state"], job["message"] = "error", tr("文献已移除，无法执行任务")
                continue
            job["state"], job["message"] = "running", tr("模型思考中")
            try:
                cfg = config.load()
                if job["kind"] == "answer":
                    translate.answer(ws, cfg, job["note"], None)
                elif job["kind"] == "retranslate":
                    translate.retranslate(ws, cfg, job["key"], job.get("hint", ""), None)
                job["state"], job["message"] = "done", tr("完成")
            except Exception as e:  # noqa: BLE001
                job["state"], job["message"] = "error", str(e)[:500]
                log.exception("小任务出错 %s", job.get("kind"))
