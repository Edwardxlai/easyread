"""回收站：删掉的论文整个文件夹挪到 文献库/.trash/<id>-<时间>，可以恢复、彻底删除、清空。"""
from __future__ import annotations

import os
import re
import shutil
import stat
import sys
import time
from datetime import datetime
from pathlib import Path

from ..app.i18n import tr
from .store import read_json

_NAME = re.compile(r"^([0-9a-f]{12})-(\d{14})$")


def _rmtree(p: Path, waits=(0.5, 1, 2)) -> None:
    """删整个文件夹。Windows 上只读文件先去掉只读再删；OneDrive 等同步盘正在同步时会短暂占住文件（WinError 5），等一下再试。"""
    def writable(func, path, *_):
        os.chmod(path, stat.S_IWRITE)
        func(path)
    hook = {"onexc": writable} if sys.version_info >= (3, 12) else {"onerror": writable}
    for wait in (*waits, None):
        try:
            shutil.rmtree(p, **hook)
            return
        except PermissionError:
            if wait is None:
                raise
            time.sleep(wait)


def _dir(root: Path) -> Path:
    return root / ".trash"


def _entry(root: Path, name: str) -> Path:
    if not _NAME.match(name or ""):
        raise ValueError(tr("回收站里没有这一项"))
    p = _dir(root) / name
    if not p.is_dir():
        raise ValueError(tr("回收站里没有这一项"))
    return p


def items(root: Path) -> list[dict]:
    out = []
    for p in _dir(root).glob("*") if _dir(root).is_dir() else []:
        m = _NAME.match(p.name)
        if not m or not p.is_dir():
            continue
        meta = (read_json(p / "paper.json", {}) or {}).get("meta", {})
        out.append({"name": p.name, "id": m.group(1), "title_zh": meta.get("title_zh", ""), "title_en": meta.get("title_en", ""),
                    "authors": meta.get("authors", ""), "deleted": datetime.strptime(m.group(2), "%Y%m%d%H%M%S").isoformat(timespec="seconds")})
    return sorted(out, key=lambda x: x["deleted"], reverse=True)


def restore(root: Path, name: str) -> str:
    src = _entry(root, name)
    pid = _NAME.match(name).group(1)
    if (root / pid).exists():
        raise ValueError(tr("文献库里已经有这篇论文了（可能后来又导入过一次）"))
    shutil.move(str(src), root / pid)
    return pid


def purge(root: Path, name: str) -> int:
    """彻底删掉回收站里的一篇。"""
    _rmtree(_entry(root, name))
    return 1


def empty(root: Path) -> int:
    """清空回收站，返回删掉了几篇。"""
    targets = [p for p in _dir(root).glob("*") if p.is_dir() and _NAME.match(p.name)] if _dir(root).is_dir() else []
    for p in targets:
        _rmtree(p)
    return len(targets)
