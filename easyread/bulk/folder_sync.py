"""Mirror local PDF folders onto the existing content-addressed library."""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path, PurePosixPath

from ..app import config
from ..app.i18n import tr
from ..app.log import log
from ..library.library import sha256_bytes
from ..library.store import DataReadError, write_json_atomic
from . import folder_files as fs
from .folder_state import import_only_paths, read_mappings

INTERVAL = 2
IMPORTS_PER_SCAN = 24
MAX_AUTO_TRANSLATE_ARRIVAL = 5
OPTIONS = {"enabled": True, "translate": False, "network_metadata": False}
# Ordinary mappings have a nonempty name. The built-in All view uses the unnamed root.
DEFAULT_ROOT = ""


def _category(root: str, relative: str) -> str:
    return f"{root}/{relative}" if relative else root


def _parent(relative: str) -> str:
    return relative.rpartition("/")[0]


class FolderSync:
    def __init__(self, app):
        self.app = app
        # Device-local paths must not travel with a cloud library. Keep each library independent.
        library_key = sha256_bytes(os.fsencode(os.path.normcase(str(app.lib.root))))
        self.path = config.HOME / "folder-sync" / (library_key + ".json")
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._observed = {}
        self._cursor = {}
        self._invalid = {}
        self._errors = {}
        self._load_error = ""
        try:
            self._set_state(read_mappings(self.path))
        except DataReadError:
            self._load_error = tr("无法读取数据文件：{path}；原文件已保留，请从备份恢复或联系维护者", path=str(self.path))
            self._set_state({})

    def _set_state(self, roots):
        folders, by_id = [], {}
        default_enabled = roots.get(DEFAULT_ROOT, {}).get("enabled", False)
        for name, watch in roots.items():
            if name != DEFAULT_ROOT:
                folders.extend(_category(name, path) for path in watch["folders"])
            elif not default_enabled:
                continue
            for path, record in watch["files"].items():
                by_id.setdefault(record["id"], []).append({"folder": _category(name, _parent(path)),
                                                           "name": PurePosixPath(path).name})
        # The HTTP list reads a single published snapshot without blocking disk scans.
        self._state = (roots, {"folders": folders, "default_enabled": default_enabled,
                               "active": any(w["enabled"] for w in roots.values())}, by_id)

    def _commit(self, roots):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.path, roots)
        self._set_state(roots)

    def library(self):
        _, summary, by_id = self._state
        return summary, by_id

    def settings(self):
        watches = {name: {"name": name, "path": w["path"], **{key: w.get(key, default) for key, default in OPTIONS.items()},
                          "files": len(w["files"]), "error": self._errors.get(name, "")}
                   for name, w in self._state[0].items()}
        default = watches.pop(DEFAULT_ROOT, None)
        return {"roots": list(watches.values()), "default": default, "error": self._load_error}

    def _watch_path(self, value, roots, name):
        path = Path(str(value or "").strip().strip('"')).expanduser()
        if not path.is_absolute() or not path.is_dir():
            raise ValueError(tr("找不到这个文件夹：{path}", path=str(path)))
        try:
            path = path.resolve(strict=True)
        except OSError as err:
            raise ValueError(tr("找不到这个文件夹：{path}", path=str(path))) from err
        excluded = [self.app.lib.root, *(Path(w["path"]) for key, w in roots.items() if key != name)]
        if any(path.is_relative_to(other) or other.is_relative_to(path) for other in excluded):
            raise ValueError(tr("这个文件夹与文献库或已有的监控文件夹重叠"))
        return path

    @staticmethod
    def _watch_name(value, roots, old_name):
        if not value or len(value) > 80 or re.search(r"[/\\\x00-\x1f]", value):
            raise ValueError(tr("请输入有效的文献库显示名称"))
        if any(value.casefold() == other.casefold() for other in roots if other != old_name):
            raise ValueError(tr("已有同名的本地文件夹，请换一个显示名称"))
        return value

    def configure(self, body):
        if self._load_error:
            raise ValueError(self._load_error)
        action, name = body.get("action"), str(body.get("name") or "").strip()
        if action == "set_default":
            name = DEFAULT_ROOT
        elif action != "add" and not name:
            raise ValueError(tr("找不到要同步的文件夹"))
        with self._lock:
            roots = dict(self._state[0])
            new_name = name
            reset = False
            options = {key: body[key] for key in OPTIONS if type(body.get(key)) is bool}
            if action == "add" or (action == "set_default" and name not in roots):
                path = self._watch_path(body.get("path"), roots, None)
                if action == "add":
                    new_name = self._watch_name(name or path.name, roots, None)
                roots[new_name] = {**OPTIONS, **options, "path": str(path), "folders": [""], "files": {}, "backlog": None}
            elif action in ("update", "set_default") and name in roots:
                old = roots[name]
                watch = {**OPTIONS, **old, **options}
                if "path" in body and str(body["path"]).strip() != old["path"]:
                    path = self._watch_path(body["path"], roots, name)
                    reset = path != Path(old["path"])
                    if reset:
                        watch.update(path=str(path), folders=[""], files={}, backlog=None)
                if action == "update" and "new_name" in body:
                    new_name = self._watch_name(str(body.get("new_name") or "").strip() or Path(watch["path"]).name, roots, name)
                if any(watch[key] and not old.get(key, OPTIONS[key]) for key in ("translate", "enabled")):
                    watch["backlog"] = None
                if name == DEFAULT_ROOT and not watch["enabled"]:
                    reset = True
                roots = {new_name if key == name else key: watch if key == name else value for key, value in roots.items()}
            elif action == "remove" and name in roots:
                del roots[name]
                reset = True
            else:
                raise ValueError(tr("找不到要同步的文件夹"))
            self._commit(roots)
            if reset or new_name != name and action == "update":
                self._observed.pop(name, None)
                self._cursor.pop(name, None)
                self._invalid.pop(name, None)
                self._errors.pop(name, None)
            return self.settings()

    def start(self):
        self._thread = threading.Thread(target=self._loop, name="folder-sync", daemon=True)
        self._thread.start()

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def _loop(self):
        while not self._stop.is_set():
            self.scan()
            self._stop.wait(INTERVAL)

    def scan(self):
        for name, watch in self._state[0].items():
            if not watch["enabled"]:
                continue
            if self._stop.is_set():
                return
            try:
                self.app.location.begin()
            except ValueError:
                return  # The library is moving or awaiting restart.
            try:
                with self._lock:
                    current = self._state[0].get(name)
                    if current and current["enabled"]:
                        self._scan_root(name, current)
            except (OSError, ValueError) as err:
                self._errors[name] = str(err)
            except Exception as err:  # Keep other watches running after a library error.
                log.exception("Folder sync failed for %s", name)
                self._errors[name] = str(err)
            finally:
                self.app.location.end()

    def _scan_root(self, name, watch):
        root = Path(watch["path"])
        folders, observed = fs.walk(root)
        previous = self._observed.get(name, {})
        backlog = import_only_paths(watch, observed, previous, MAX_AUTO_TRANSLATE_ARRIVAL)
        invalid = {p: stamp for p, stamp in self._invalid.get(name, {}).items() if observed.get(p) == stamp}
        files = {p: record for p, record in watch["files"].items() if p in observed}
        errors, processed = [], 0
        paths = list(observed)
        cursor = self._cursor.get(name)
        start = paths.index(cursor) + 1 if cursor in observed else 0
        for relative in paths[start:] + paths[:start]:
            if self._stop.is_set():
                break
            stamp = observed[relative]
            old = files.get(relative, {})
            if old.get("stamp") == stamp:
                backlog.discard(relative)
                continue
            if relative in invalid:
                continue
            if previous.get(relative) != stamp or processed >= IMPORTS_PER_SCAN:
                continue
            processed += 1
            # Retry locked files, but do not let them consume every scan's budget.
            self._cursor[name] = relative
            path = root / relative
            try:
                data = fs.read_stable(fs.checked_path(root, path), stamp)
                pid = self._import(path, data, watch.get("translate", False) and relative not in backlog,
                                   network=watch.get("network_metadata", False))
                files[relative] = {"id": pid, "stamp": stamp}
                backlog.discard(relative)  # a later edition at this path gets its own decision
            except fs.IncompletePDF:
                invalid[relative] = stamp
                files.pop(relative, None)
            except (OSError, ValueError) as err:
                errors.append(f"{path.name} · {err}")
        if invalid:
            errors.append(tr("有 {n} 个 PDF 尚未下载完整或文件已损坏", n=len(invalid)))
        self._errors[name] = "\n".join(errors[:3])
        backlog = sorted(backlog)
        if files != watch["files"] or folders != watch["folders"] or backlog != watch.get("backlog"):
            self._commit({**self._state[0], name: {**watch, "files": files, "folders": folders, "backlog": backlog}})
        # A failed save must not make a large arrival look like a small new batch.
        self._observed[name], self._invalid[name] = observed, invalid

    def _import(self, path, data, translate, *, network):
        lib = self.app.lib
        digest = sha256_bytes(data)
        pid = digest[:12]
        existing = lib.ws(pid)
        if not existing and any((lib.root / ".trash").glob(f"{pid}-[0-9]*")):
            return pid  # Leave deletion and restoration under the library's control.
        ws, fresh = (existing, False) if existing else lib.create_from_pdf(data, path.name, network_metadata=network)
        meta = ws.load("paper")["meta"]
        if meta.get("source_sha256") != digest:
            raise ValueError(tr("PDF 内容与文献库中的原文件不一致"))
        job = ws.load("job") or {}
        if not job and (fresh or not meta.get("pages")):
            try:
                self.app.jobs.enqueue(ws, translate_after=fresh and translate)
            except ValueError:
                if (ws.load("job") or {}).get("state") not in ("queued", "running", "confirm"):
                    raise
        return pid
