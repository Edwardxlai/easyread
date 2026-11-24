"""Import new PDFs from explicitly selected folders into ordinary library categories."""
from __future__ import annotations

import os
import threading
from pathlib import Path

from ..app import config
from ..app.i18n import tr
from ..app.log import log
from ..library.library import sha256_bytes
from ..library.store import read_json, write_json_atomic
from . import folder_files
from .runner import cat_path

INTERVAL = 3


class FolderWatch:
    def __init__(self, app):
        self.app = app
        library = os.path.normcase(str(app.lib.root.resolve()))
        self.path = config.HOME / "folder-watch" / (sha256_bytes(os.fsencode(library)) + ".json")
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.previous = {}
        self.thread = None
        self.roots = None

    def _roots(self):
        if self.roots is None:
            self.roots = read_json(self.path, {}) or {}
        return self.roots

    def _save(self, roots):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.path, roots)
        self.roots = roots

    def options(self, path):
        with self.lock:
            watch = self._roots().get(os.path.normcase(str(Path(path).resolve())))
            return {k: watch[k] for k in ("link", "keep_filename")} if watch else None

    def configure(self, path, enabled, link, keep_filename):
        root = Path(path).expanduser()
        if not root.is_absolute():
            raise ValueError(tr("找不到这个文件夹：{path}", path=path))
        root = root.resolve()
        key = os.path.normcase(str(root))
        with self.lock:
            roots = self._roots().copy()
            if enabled:
                if not root.is_dir():
                    raise ValueError(tr("找不到这个文件夹：{path}", path=path))
                excluded = [self.app.lib.root.resolve(), *(Path(k) for k in roots if k != key)]
                if any(root.is_relative_to(p) or p.is_relative_to(root) for p in excluded):
                    raise ValueError(tr("请选择与文献库及其他自动导入目录互不包含的文件夹"))
                roots[key] = {**roots.get(key, {"done": {}}), "path": str(root),
                              "link": link, "keep_filename": keep_filename}
            else:
                roots.pop(key, None)
                self.previous.pop(key, None)
            self._save(roots)

    def start(self):
        self.thread = threading.Thread(target=self._loop, name="folder-watch", daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=3)

    def _loop(self):
        while not self.stop.is_set():
            try:
                with self.lock:
                    keys = list(self._roots())
                for key in keys:
                    if self.stop.is_set():
                        break
                    try:
                        self.app.location.begin()
                        try:
                            self._scan(key)
                        finally:
                            self.app.location.end()
                    except (FileNotFoundError, PermissionError):
                        continue  # Offline drives can return at the same location.
                    except (OSError, ValueError):
                        log.debug("Cannot scan watched folder %s", key, exc_info=True)
            except Exception:
                log.exception("Could not read automatic import state")
            self.stop.wait(INTERVAL)

    def _scan(self, key):
        with self.lock:
            watch = self._roots().get(key)
        if not watch:
            return
        root = Path(watch["path"])
        _, found = folder_files.walk(root)
        with self.lock:
            if self._roots().get(key) is not watch:
                return
            previous = self.previous.get(key, {})
            self.previous[key] = found
            done = {p: stamp for p, stamp in watch["done"].items() if p in found}
        for name, stamp in found.items():
            if self.stop.is_set():
                break
            if done.get(name) == stamp or previous.get(name) != stamp:
                continue
            with self.lock:
                if self._roots().get(key) is not watch:
                    return
                try:
                    source = folder_files.checked_path(root, root / name)
                    data = folder_files.read_stable(source, stamp)
                    self._import(root, source, data, watch)
                except (OSError, ValueError):
                    continue  # Incomplete or inaccessible PDFs are retried.
                done[name] = stamp
        with self.lock:
            if self._roots().get(key) is watch and done != watch["done"]:
                self._save({**self._roots(), key: {**watch, "done": done}})

    def _import(self, root, source, data, watch):
        lib = self.app.lib
        if watch["link"]:
            ws, _ = lib.import_pdf_path(source, link=True, keep_filename=watch["keep_filename"])
        else:
            ws, _ = lib.create_from_pdf(data, source.name, keep_filename=watch["keep_filename"])
        category = cat_path(root.name or str(root.anchor).rstrip("/\\\\:"), *source.parent.relative_to(root).parts)

        def add_category(item):
            item["tags"] = list(dict.fromkeys([*(item.get("tags") or []), category]))
            return item

        ws.update("item", add_category)
        prepared = (ws.load("paper") or {}).get("meta", {}).get("pages")
        active = (ws.load("job") or {}).get("state") in ("queued", "running")
        if not prepared and not active:
            self.app.jobs.enqueue(ws, translate_after=False)
