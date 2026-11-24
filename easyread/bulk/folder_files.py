"""Read stable PDF files inside a watched folder."""
from __future__ import annotations

import os
import stat
from pathlib import Path

from ..app.i18n import tr
from .folder import MAX_FILES


class IncompletePDF(ValueError):
    pass


def _redirected(info: os.stat_result) -> bool:
    junction = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", None) == junction


def checked_path(root: Path, path: Path) -> Path:
    if not path.is_relative_to(root) or path.resolve(strict=True) != path or _redirected(path.lstat()):
        raise ValueError(tr("文件夹同步只操作所选目录中的普通文件和文件夹"))
    return path


def _stamp(info: os.stat_result) -> list[int]:
    return [info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino]


def stamp(path: Path) -> list[int]:
    info = path.lstat()
    if _redirected(info) or not stat.S_ISREG(info.st_mode):
        raise ValueError(tr("文件夹同步只操作所选目录中的普通文件和文件夹"))
    return _stamp(info)


def walk(root: Path) -> tuple[list[str], dict[str, list[int]]]:
    checked_path(root, root)
    folders, files = [], {}

    def unavailable(error):
        raise error

    def entry_stat(path):
        try:
            info = path.lstat()
        except FileNotFoundError:  # The desktop may be moving it during this scan.
            return None
        return None if _redirected(info) else info

    for directory, children, names in os.walk(root, onerror=unavailable):
        here = Path(directory)
        relative = here.relative_to(root).as_posix()
        folders.append("" if relative == "." else relative)
        children[:] = sorted(name for name in children
                             if not name.startswith(".") and entry_stat(here / name) is not None)
        for name in sorted(names):
            if name.startswith(".") or not name.lower().endswith(".pdf"):
                continue
            path = here / name
            info = entry_stat(path)
            if info is not None and stat.S_ISREG(info.st_mode):
                if len(files) >= MAX_FILES:
                    raise ValueError(tr("这个文件夹里的 PDF 超过 {n} 个，请分几次导入，每次选一个子文件夹", n=MAX_FILES))
                files[path.relative_to(root).as_posix()] = _stamp(info)
    return folders, files


def read_stable(path: Path, expected: list[int]) -> bytes:
    if stamp(path) != expected:
        raise ValueError(tr("PDF 已变化，请等待文件夹重新同步"))
    data = path.read_bytes()
    if stamp(path) != expected:
        raise ValueError(tr("PDF 已变化，请等待文件夹重新同步"))
    if not data.startswith(b"%PDF") or b"%%EOF" not in data[-65536:]:
        raise IncompletePDF(tr("PDF 尚未下载完整或文件已损坏"))
    return data
