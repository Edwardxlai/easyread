"""A resumable, library-wide label review. Each model call runs outside the request thread."""
from __future__ import annotations

import os
import threading
from copy import deepcopy
from uuid import uuid4

from ..app import config
from ..app.i18n import tr
from ..app.log import log
from ..chat import chat_models, label_review as planner, paper_labeling
from ..library import label_review, paper_labels
from ..library.store import DataReadError, read_json, write_json_atomic

STATE = ".label-organizer.json"
_INIT_LOCK = threading.Lock()
_PUBLIC = ("id", "state", "phase", "total", "done", "assigned", "revision", "proposals",
           "messages", "error", "warnings", "applied")


def _idle():
    return {"id": "", "state": "idle", "phase": "", "total": 0, "done": 0, "assigned": 0,
            "revision": 0, "proposals": [], "messages": [], "warnings": [], "error": "", "applied": []}


def _lease(root):
    """OS releases the lease on process exit, including during a long model call."""
    handle = (root / ".label-organizer.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, PermissionError):
        handle.close()
        return None
    except BaseException:
        handle.close()
        raise
    return handle


def _get(app):
    with _INIT_LOCK:
        if not hasattr(app, "label_organizer"):
            app.label_organizer = Organizer(app.lib, app.location)
        return app.label_organizer


def busy(app):
    coordinator = getattr(app, "label_organizer", None)
    return coordinator is not None and coordinator.active


def request(app, action, body=None):
    return _get(app).act(action, body or {})


class Organizer:
    def __init__(self, library, location):
        self.library, self.location = library, location
        self.path = library.root / STATE
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.active = False

    def _read(self):
        return read_json(self.path, None) or _idle()

    def _save(self, job):
        write_json_atomic(self.path, job)

    def _public(self, job):
        return {k: deepcopy(job[k]) for k in _PUBLIC}

    def _recover(self, job):
        if job["state"] in ("running", "applying"):
            job["state"] = "paused"
        return job

    def act(self, action, body):
        with self.lock:
            job = self._read()
            if action == "status":
                if not self.active and job["state"] in ("running", "applying"):
                    lease = _lease(self.library.root)
                    if lease:
                        lease.close()
                        self._recover(job)
                return self._public(job)
            if action != "start" and (not job["id"] or body.get("id") != job["id"]):
                raise ValueError(tr("整理建议已更新，请刷新后再试"))
            if self.active:
                if action == "pause" and job["state"] == "running":
                    self.cancel.set()
                if action in ("start", "resume", "pause") or (action == "confirm" and self._same_selection(job, body)):
                    return self._public(job)
                raise ValueError(tr("文献整理任务正在运行"))

            lease = _lease(self.library.root)
            if not lease:
                if action in ("start", "resume"):
                    return self._public(self._read())
                raise ValueError(tr("文献整理任务正在运行"))
            try:
                job = self._recover(self._read())
                if action != "start" and body.get("id") != job["id"]:
                    raise ValueError(tr("整理建议已更新，请刷新后再试"))
                if not self._prepare(job, action, body):
                    return self._public(job)
                self.location.begin()
                try:
                    job.update(state="applying" if job["phase"] == "confirm" else "running", error="")
                    self._save(job)
                    self.active = True
                    self.cancel.clear()
                    thread = threading.Thread(target=self._work, args=(job, lease), daemon=True)
                    response = self._public(job)
                    thread.start()
                    lease = None  # The worker owns it now.
                    return response
                except BaseException:
                    self.active = False
                    self.location.end()
                    raise
            finally:
                if lease:
                    lease.close()

    @staticmethod
    def _same_selection(job, body):
        selected = body.get("selected")
        return (job["phase"] == "confirm" and body.get("revision") == job["revision"] and
                isinstance(selected, list) and all(isinstance(pid, str) for pid in selected)
                and set(job.get("selected", ())) == set(selected))

    def _prepare(self, job, action, body):
        if action == "start":
            if job["state"] not in ("idle", "complete"):
                return False
            queue = [ws.id for ws in self.library.all()]
            catalog = paper_labels.available(self.library)
            job.update(_idle())
            job.update(id=uuid4().hex, phase="scan", queue=queue, total=len(queue), records=[],
                       catalog=[{**l.fields(), "origin": l.origin, "aliases": list(l.aliases)} for l in catalog.values()])
            return True
        if action == "resume":
            return job["state"] in ("paused", "error")
        if action == "pause":
            return False
        if action == "confirm" and job["state"] == "complete" and self._same_selection(job, body):
            return False
        if job["state"] != "review" or body.get("revision") != job["revision"]:
            raise ValueError(tr("整理建议已更新，请刷新后再试"))
        if action == "feedback":
            message = body.get("message")
            if not isinstance(message, str) or not message.strip() or len(message) > 4000:
                raise ValueError(tr("请将整理意见控制在 4000 字以内"))
            job["messages"].append({"role": "user", "content": message.strip()})
            job["phase"] = "feedback"
            return True
        selected = body.get("selected")
        available = {p["id"] for p in job["proposals"]}
        if (action != "confirm" or not isinstance(selected, list) or
                any(not isinstance(pid, str) or pid not in available for pid in selected)):
            raise ValueError(tr("整理建议已更新，请刷新后再试"))
        job.update(phase="confirm", selected=list(dict.fromkeys(selected)), receipts=[])
        return True

    def _scan(self, job, known, cfg):
        while job["done"] < job["total"] and not self.cancel.is_set():
            pid = job["queue"][job["done"]]
            ws = self.library.ws(pid)
            if ws:
                try:
                    pending = job.get("pending")
                    if pending is None:
                        summary = self.library.summary(ws)
                        title = summary["display_title"] or summary["title_zh"] or summary["title_en"] or pid
                        result = paper_labeling.analyze(self.library, ws, known=known, cancel=self.cancel, cfg=cfg, bulk=True)
                        if self.cancel.is_set():
                            return
                        # Journal the verified model output BEFORE assigning anything to the paper.
                        pending = job["pending"] = {"title": title, **result}
                        self._save(job)
                    saved = ws.load("item") or {}
                    receipt = saved.get("label_organizer_receipt") or {}
                    if receipt.get("job") == job["id"]:
                        added = receipt["added"]
                    else:
                        confirmed = paper_labels.save_analysis(self.library, ws,
                            {"matches": pending["matches"], "suggestions": []}, known, organizer_job=job["id"])
                        added = len(confirmed["added"])
                        saved = ws.load("item") or {}
                    job["assigned"] += added
                    job["records"].append({"id": pid, "title": pending["title"], "suggestions": pending["suggestions"],
                                           "labels": saved.get("labels", []), "proof": saved.get("label_evidence", {})})
                except DataReadError as error:
                    if error.path == self.library.root / paper_labels.CATALOG:
                        raise
                    job["warnings"].append({"id": pid, "message": str(error)})
            else:
                job["warnings"].append({"id": pid, "message": tr("没有这篇论文")})
            job.pop("pending", None)
            job["done"] += 1
            self._save(job)
        if not self.cancel.is_set():
            job["phase"] = "synthesis"
            self._save(job)

    def _work(self, job, lease):
        try:
            if job["phase"] == "confirm":
                proposals = {p["id"]: p for p in job["proposals"]}
                for pid in job["selected"]:
                    if pid in job["receipts"]:
                        continue
                    try:
                        label_review.apply_proposal(self.library, proposals[pid])
                        job["applied"].append(pid)
                    except label_review.StaleProposal as exc:
                        job["warnings"].append({"id": pid, "message": str(exc)})
                    job["receipts"].append(pid)
                    self._save(job)
                job["state"] = "complete"
                return
            known = {l["name"].casefold(): paper_labels.Label(l["name"], l["rule"], origin=l["origin"],
                                                               aliases=tuple(l["aliases"])) for l in job["catalog"]}
            # Keep the current default consistent while running; an explicit resume can pick a repaired model.
            cfg, _ = chat_models.engine_cfg(config.load(), None)
            if job["phase"] == "scan":
                self._scan(job, known, cfg)
            if not self.cancel.is_set():
                current = paper_labels.available(self.library)
                proposals, reply = planner.synthesize(current, job["records"], job["proposals"], job["messages"], self.cancel, cfg=cfg)
                if not self.cancel.is_set():
                    job["proposals"] = proposals
                    if reply:
                        job["messages"].append({"role": "assistant", "content": reply})
                    job["revision"] += 1
                    job["state"] = "review"
        except Exception as exc:
            if not self.cancel.is_set():
                job.update(state="error", error=str(exc)[:700])
                log.exception("Library label organizer failed during %s", job["phase"])
        finally:
            with self.lock:
                if self.cancel.is_set() and job["state"] == "running":
                    job["state"] = "paused"
                try:
                    self._save(job)
                finally:
                    lease.close()
                    self.active = False
                    self.location.end()
