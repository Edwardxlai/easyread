"""文件读写：原子写、跨进程锁、用户修改的合并规则。

一篇论文一个目录，文件按“谁写”分开，这是互不覆盖的根本保证：
  paper.json       翻译方（对话里的 agent 或后台翻译任务）写：原文、译文、术语、参考文献
  discussion.json  翻译方写：解释、问答、回复、原文核对提示
  reader.json      只由页面经 /api/.../ops 写：用户改的译文、笔记、划线、论文笔记、进度
  item.json        只由页面经 /api/items 写：标签、阅读状态、星标、打开时间
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .fs_retry import retry_write
from .glossary import valid_entries

SCHEMA = 2


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


class DataReadError(ValueError):
    """A saved JSON file is unreadable; callers must not overwrite it with defaults."""

    def __init__(self, path: Path):
        self.path = Path(path)
        super().__init__(f"Cannot read data file: {self.path}; the original file has been preserved")


def read_json(path: Path, default=None):
    for attempt in range(10):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return default
        except PermissionError:  # Windows：另一个线程正用 write_json_atomic 替换这个文件，稍等重试
            if attempt == 9:
                raise
            time.sleep(0.02 * (attempt + 1))


def write_json_atomic(path: Path, data) -> None:
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows：别的进程正在读，稍等重试
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


@contextmanager
def dir_lock(folder: Path, name: str = ".write.lock", timeout: float = 15.0):
    """O_EXCL 建锁文件做跨进程互斥；超过 30 秒的旧锁视为残留。"""
    lock = Path(folder) / name
    start = time.time()
    while True:
        try:
            fd = retry_write(lambda: os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            try:
                retry_write(lambda: os.write(fd, str(os.getpid()).encode()))
            except OSError:
                os.close(fd)
                retry_write(lambda: lock.unlink(missing_ok=True))
                raise
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 30:
                    lock.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.time() - start > timeout:
                from ..app.i18n import tr
                raise TimeoutError(tr("等锁超时：{lock}", lock=lock))
            time.sleep(0.05)
    try:
        yield
    finally:
        retry_write(lambda: lock.unlink(missing_ok=True))


def text_hash(s: str | None) -> str:
    """和页面 util.js 的 hashText 一致：FNV-1a 32 位，按 UTF-16 码元。"""
    h = 0x811C9DC5
    b = (s or "").encode("utf-16-le")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def file_version(path: Path) -> str:
    try:
        st = Path(path).stat()
        return f"{st.st_mtime_ns:x}-{st.st_size:x}"
    except FileNotFoundError:
        return "0"


def empty_reader() -> dict:
    return {"schema": SCHEMA, "rev": 0, "edits": {}, "notes": {}, "paper_note": {}, "progress": {}}


def empty_discussion() -> dict:
    return {"schema": SCHEMA, "entries": []}


# ---------- reader.json 的操作合并 ----------
# 每个操作幂等、带时间戳；同一对象以较新的为准。页面断网时操作留在浏览器，恢复后重发不会重复或倒退。

def _newer(a: str | None, b: str | None) -> bool:
    return (a or "") >= (b or "")


def apply_ops(reader: dict, ops: list[dict]) -> list[str]:
    applied = []
    edits = reader.setdefault("edits", {})
    notes = reader.setdefault("notes", {})
    progress = reader.setdefault("progress", {})
    for op in ops:
        kind = op.get("op")
        at = op.get("at") or now_iso()
        if kind == "edit":
            block = str(op["block"])
            cur = edits.get(block)
            if cur and not _newer(at, cur.get("at")):
                continue
            if op.get("zh") is None:  # 恢复译者稿：留一条撤销记录
                if cur:
                    edits[block] = {"reverted": True, "prev": cur.get("zh"), "at": at}
            else:
                entry = {"zh": op["zh"], "base": op.get("base", ""), "at": at}
                if cur and cur.get("zh") and cur.get("zh") != op["zh"]:
                    entry["prev"] = cur.get("zh")
                edits[block] = entry
            applied.append(f"edit:{block}")
        elif kind == "note":
            note = dict(op["note"])
            nid = str(note["id"])
            cur = notes.get(nid)
            if cur and not _newer(note.get("updated"), cur.get("updated")):
                continue
            notes[nid] = note
            applied.append(f"note:{nid}")
        elif kind == "note_del":
            nid = str(op["id"])
            cur = notes.get(nid)
            if not cur or _newer(at, cur.get("updated")):
                notes[nid] = {**(cur or {"id": nid}), "deleted": True, "updated": at}
                applied.append(f"note_del:{nid}")
        elif kind == "paper_note":
            cur = reader.get("paper_note") or {}
            if _newer(at, cur.get("at")):
                reader["paper_note"] = {"body": op.get("body", ""), "at": at}
                applied.append("paper_note")
        elif kind == "progress":
            if _newer(at, progress.get("at")):
                progress.update({"block": op.get("block"), "at": at})
                progress.pop("off", None)  # Older clients do not send a block offset.
                for key in ("ratio", "off"):  # off：线在块里的位置，长段落靠它落回原处
                    if op.get(key) is not None:
                        progress[key] = op[key]
            applied.append("progress")
    if applied:
        reader["rev"] = int(reader.get("rev", 0)) + 1
    return applied


class Workspace:
    """一篇论文的目录。"""

    PARTS = ("paper", "discussion", "reader", "layout")

    def __init__(self, root: Path):
        self.root = Path(root).resolve()

    @property
    def id(self) -> str:
        return self.root.name

    paper_path = property(lambda s: s.root / "paper.json")
    discussion_path = property(lambda s: s.root / "discussion.json")
    reader_path = property(lambda s: s.root / "reader.json")
    item_path = property(lambda s: s.root / "item.json")
    journal_path = property(lambda s: s.root / "history" / "reader.log.jsonl")

    @property
    def source_pdf(self) -> Path:
        """Original PDF only: generated files remain inside this workspace."""
        meta = (self.load("paper") or {}).get("meta", {})
        linked = meta.get("source_pdf_path")
        if not linked:
            return self.root / "source.pdf"
        path = Path(linked)
        if not path.is_absolute() or not path.is_file():
            from ..app.i18n import tr
            raise ValueError(tr("链接的 PDF 不存在或不可读：{path}；请恢复原文件到此位置", path=str(path)))
        try:
            with path.open("rb") as stream:
                if not stream.read(4).startswith(b"%PDF"):
                    raise ValueError
        except (OSError, ValueError):
            from ..app.i18n import tr
            raise ValueError(tr("链接的 PDF 不存在或不可读：{path}；请恢复原文件到此位置", path=str(path))) from None
        return path

    def load(self, name: str):
        defaults = {"reader": empty_reader(), "discussion": empty_discussion(), "layout": {}, "item": {}, "job": {}, "chat": {"messages": []}}
        path = self.root / f"{name}.json"
        try:
            data = read_json(path, defaults.get(name))
        except (UnicodeError, json.JSONDecodeError) as e:
            raise DataReadError(path) from e
        if name == "paper" and isinstance(data, dict) and "glossary" in data:
            data["glossary"] = valid_entries(data["glossary"])
        return data

    def versions(self) -> dict:
        v = {n: file_version(self.root / f"{n}.json") for n in self.PARTS}
        v["job"] = file_version(self.root / "job.json")
        return v

    def apply_reader_ops(self, ops: list[dict], client: str = "") -> dict:
        with dir_lock(self.root):
            reader = self.load("reader")
            applied = apply_ops(reader, ops)
            if applied:
                self._journal(ops, client)
                self._snapshot()
                write_json_atomic(self.reader_path, reader)
            return {"rev": reader.get("rev", 0), "applied": applied}

    def _journal(self, ops, client):
        self.journal_path.parent.mkdir(exist_ok=True)
        with open(self.journal_path, "a", encoding="utf-8") as f:
            for op in ops:
                f.write(json.dumps({"t": now_iso(), "client": client, **op}, ensure_ascii=False) + "\n")

    def _snapshot(self, every_seconds: int = 600):
        """reader.json 每 10 分钟最多留一份快照，出事可以回滚。"""
        hist = self.root / "history"
        hist.mkdir(exist_ok=True)
        snaps = sorted(hist.glob("reader-*.json"))
        if snaps and time.time() - snaps[-1].stat().st_mtime < every_seconds:
            return
        if self.reader_path.exists():
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            (hist / f"reader-{stamp}.json").write_bytes(self.reader_path.read_bytes())

    def update(self, name: str, fn):
        """在锁内读-改-写一个翻译方的文件（paper / discussion / job / item）。"""
        with dir_lock(self.root):
            data = self.load(name)
            result = fn(data)
            write_json_atomic(self.root / f"{name}.json", data)
            return result

    def patch_item(self, fields: dict) -> dict:
        allowed = {"tags", "status", "starred", "rating", "last_opened", "meta_override", "archived"}

        def apply(item):
            for k, v in fields.items():
                if k in allowed:
                    item[k] = v
            item["updated"] = now_iso()
            return item
        return self.update("item", apply)
