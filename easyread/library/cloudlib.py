"""文献库位置切换：只复制，核对完成才更新配置；旧库和目标已有文件都保留。"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import stat
import uuid
from pathlib import Path

from ..app import config
from .cloudlib_detect import detect, target_path  # noqa: F401
from ..app.i18n import tr
from ..app.log import log
from .paper_labels import CATALOG
from .store import read_json, write_json_atomic

MIGRATION_MARKER = ".easyread-migration.json"
STAGING_PREFIX = ".easyread-copy-"


class Incomplete(ValueError):
    """目标里留着本机一次没完成的迁移；页面可以提供“清理”。"""

    def __init__(self, root: Path):
        self.path = str(root)
        super().__init__(tr("目标文献库迁移未完成（{path}），可以先清理未完成的迁移；原文献库仍然保留", path=str(root)))


def _incomplete(root: Path) -> bool:
    marker = root / MIGRATION_MARKER
    if not marker.exists() and not marker.is_symlink():
        return False
    try:
        if _linked(marker):
            return True
        data = read_json(marker, {})
        # ready 先于配置切换写入，表示目标已完整发布；不比较路径，同一个网盘目录在另一台电脑上路径不同。
        if data.get("state") == "ready":
            return False
        # 别的电脑留下的标记随网盘同步过来：那边的事，这里只是普通文献库，不拦。
        host = data.get("host")
        return not (host and host != socket.gethostname())
    except (OSError, ValueError, AttributeError):
        return True


def _writable(folder: Path) -> bool:
    """只试一次：tempfile 在 Windows 上遇到没权限的目录会重试 TMP_MAX（约 21 亿）次，后端就卡死了。"""
    probe = folder / f".easyread-probe-{uuid.uuid4().hex}"
    try:
        fd = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError:
        return False
    os.close(fd)
    try:
        probe.unlink()
    except OSError:
        pass
    return True


def _linked(path: Path) -> bool:
    info = path.lstat()
    # 云端占位文件也带 REPARSE_POINT，不能一律拒绝；只拒绝符号链接和目录联接。
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) in (0xA0000003, 0xA000000C)


def _manifest(root: Path) -> dict[str, tuple[int, int]]:
    """逐级检查再遍历，不能让链接把范围带出论文目录。"""
    files = {}
    if _linked(root):
        raise ValueError(tr("文献库中有符号链接或目录联接，请改用普通文件夹：{path}", path=str(root)))
    if root.is_file():
        s = root.stat()
        return {".": (s.st_size, s.st_mtime_ns)}

    def walk(folder):
        if _linked(folder):
            raise ValueError(tr("文献库中有符号链接或目录联接，请改用普通文件夹：{path}", path=str(folder)))
        for p in folder.iterdir():
            if _linked(p):
                raise ValueError(tr("文献库中有符号链接或目录联接，请改用普通文件夹：{path}", path=str(p)))
            if p.is_dir():
                walk(p)
            elif p.is_file():
                s = p.stat()
                files[p.relative_to(root).as_posix()] = (s.st_size, s.st_mtime_ns)
            else:
                raise ValueError(tr("文献库中有无法复制的特殊文件：{path}", path=str(p)))
    walk(root)
    return files


def _papers(root: Path) -> list[Path]:
    if not root.exists():
        return []
    found = []
    for p in sorted(root.iterdir()):
        if p.name.startswith("."):
            continue
        if _linked(p):
            raise ValueError(tr("文献库中有符号链接或目录联接，请改用普通文件夹：{path}", path=str(p)))
        if p.is_dir() and (p / "item.json").is_file():
            found.append(p)
    return found


def inspect(path: str | Path, *, exact: bool = False) -> dict:
    root = Path(path).resolve() if exact else target_path(path)
    if _incomplete(root):
        raise Incomplete(root)
    if root.exists() and not root.is_dir():
        return {"path": str(root), "exists": True, "writable": False, "papers": 0, "bytes": 0}
    papers = _papers(root)
    size = sum(sum(n for n, _ in _manifest(p).values()) for p in papers)
    if (root / ".trash").exists():
        size += sum(n for n, _ in _manifest(root / ".trash").values())
    parent = root
    while not parent.exists():
        if parent == parent.parent:
            raise ValueError(tr("路径不存在：{path}", path=str(root)))
        parent = parent.parent
    # 实际创建一个文件检测 ACL；不创建用户选择的目标目录。
    writable = _writable(parent)
    return {"path": str(root), "exists": root.exists(), "writable": writable, "papers": len(papers), "bytes": size}


def _sha(paper: Path) -> str:
    # Do not read external PDFs during library migration.
    meta = (read_json(paper / "paper.json", {}) or {}).get("meta", {})
    if meta.get("source_pdf_path"):
        digest = meta.get("source_sha256", "")
        return digest if isinstance(digest, str) and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest) else ""
    pdf = paper / "source.pdf"
    if not pdf.exists():
        return ""
    if _linked(pdf):
        raise ValueError(tr("文献库中有符号链接或目录联接，请改用普通文件夹：{path}", path=str(pdf)))
    digest = hashlib.sha256()
    with pdf.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _copy_verified(src: Path, dst: Path):
    if src.is_file():
        if _linked(src):
            raise ValueError(tr("文献库中有符号链接或目录联接，请改用普通文件夹：{path}", path=str(src)))
        before = src.stat()
        shutil.copy2(src, dst)
        after = src.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or dst.stat().st_size != before.st_size:
            raise ValueError(tr("复制核对失败，文献库位置没有更改"))
        return {".": (before.st_size, before.st_mtime_ns)}
    before = _manifest(src)
    # 先建目录、逐文件复制，禁止 copytree 默认跟随链接。
    dst.mkdir()
    for rel in before:
        source, target = src / rel, dst / rel
        if _linked(source) or not source.resolve().is_relative_to(src.resolve()):
            raise ValueError(tr("复制过程中源文件发生变化，请重试"))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    after, copied = _manifest(src), _manifest(dst)
    if before != after or {p: n for p, (n, _) in before.items()} != {p: n for p, (n, _) in copied.items()}:
        raise ValueError(tr("复制核对失败，文献库位置没有更改"))
    return before


def move(src: str | Path, dst: str | Path, mode: str) -> dict:
    if config.temp_library():
        raise ValueError(tr("临时文献库不能更改位置"))
    requested = dst
    src, dst = Path(src).resolve(), target_path(dst)
    requested = Path(requested).expanduser().resolve()
    if mode not in ("copy", "use", "merge"):
        raise ValueError(tr("请选择复制、使用或合并文献库"))
    if any(src == target or src.is_relative_to(target) or target.is_relative_to(src)
           for target in (requested, dst)):
        raise ValueError(tr("新旧文献库不能相同，也不能互相包含"))
    state = inspect(dst, exact=True)
    if not state["writable"]:
        raise ValueError(tr("目标文件夹不可写"))
    if mode == "copy" and state["papers"]:
        raise ValueError(tr("目标已有论文，请选择使用或合并文献库"))
    if mode in ("use", "merge") and not state["papers"]:
        raise ValueError(tr("目标还没有论文，请选择复制文献库"))
    result = {"ok": True, "path": str(dst), "old_path": str(src), "copied": 0, "skipped": [],
              "restart_required": True, "message": tr("文献库位置已更改，需要重启 EasyRead 才能生效")}
    if mode == "use":
        config.save({"library_dir": str(dst)})
        _drop_ready_marker(dst)
        return result
    papers = _papers(src)
    digests = {_sha(p) for p in _papers(dst)} - {""} if mode == "merge" else set()
    entries = []
    for p in papers:
        if (dst / p.name).exists():
            if mode == "copy":
                raise ValueError(tr("目标中已有同名文件或文件夹，不会覆盖：{name}", name=p.name))
            result["skipped"].append({"id": p.name, "reason": tr("目标已有同名文件夹，已保留目标内容")})
            continue
        digest = _sha(p) if mode == "merge" else ""
        if digest and digest in digests:
            result["skipped"].append({"id": p.name, "reason": tr("目标已有相同 PDF，已跳过")})
            continue
        if digest:
            digests.add(digest)
        entries.append((p, Path(p.name)))
    if (src / ".trash").exists():
        if _linked(src / ".trash"):
            raise ValueError(tr("文献库中有符号链接或目录联接，请改用普通文件夹：{path}", path=str(src / ".trash")))
        trash_entries = list((src / ".trash").iterdir()) if (dst / ".trash").exists() else [src / ".trash"]
        for p in trash_entries:
            target = Path(".trash") if p == src / ".trash" else Path(".trash") / p.name
            if (dst / target).exists():
                if mode == "copy":
                    raise ValueError(tr("目标中已有同名文件或文件夹，不会覆盖：{name}", name=str(target)))
                result["skipped"].append({"id": str(target), "reason": tr("目标已有同名文件夹，已保留目标内容")})
            else:
                entries.append((p, target))
    labels = src / CATALOG
    if mode == "copy" and (labels.exists() or labels.is_symlink()):
        entries.append((labels, Path(CATALOG)))
    dst.mkdir(parents=True, exist_ok=True)
    staging = dst / f"{STAGING_PREFIX}{uuid.uuid4().hex}"
    staging.mkdir()  # 不用 mkdtemp：同样会在没权限时无限重试
    marker = dst / MIGRATION_MARKER
    created, parents = [], []
    marker_owned, ready, committed = False, False, False
    transaction = {"host": socket.gethostname(), "source": str(src), "target": str(dst), "staging": staging.name,
                   "entries": [str(relative) for _, relative in entries], "state": "publishing"}

    def remember(path):
        info = path.stat()
        created.append((path, info.st_dev, info.st_ino))

    try:
        snapshots = []
        for i, (source, _) in enumerate(entries):
            snapshots.append(_copy_verified(source, staging / str(i)))
        if any(_manifest(source) != snapshot for (source, _), snapshot in zip(entries, snapshots)):
            raise ValueError(tr("复制过程中源文件发生变化，请重试"))
        # 持久标记先于任何论文发布；崩溃或回滚被网盘锁住时，半库不能再被接管。
        with marker.open("x", encoding="utf-8") as output:
            marker_owned = True
            json.dump(transaction, output)
            output.flush()
            os.fsync(output.fileno())
        # 此时尚未改配置；目标同名项即使在复制期间出现，也不能覆盖。
        for i, (_, relative) in enumerate(entries):
            target = dst / relative
            if not target.parent.resolve().is_relative_to(dst):
                raise ValueError(tr("复制过程中目标文件夹发生变化，请重试"))
            if not target.parent.exists():
                target.parent.mkdir()
                parents.append(target.parent)
            if target.exists() or target.is_symlink():
                raise ValueError(tr("目标中已有同名文件或文件夹，不会覆盖：{name}", name=str(relative)))
            # mkdir 是跨平台排他占位；之后逐个移动，只写入自己刚建的目录。
            staged = staging / str(i)
            if staged.is_dir():
                target.mkdir(exist_ok=False)
                remember(target)
                for child in staged.iterdir():
                    child.rename(target / child.name)
            else:
                with target.open("xb") as output, staged.open("rb") as source:
                    remember(target)
                    shutil.copyfileobj(source, output)
                if target.stat().st_size != staged.stat().st_size:
                    raise ValueError(tr("复制核对失败，文献库位置没有更改"))
            if relative.parts[0] not in (".trash", CATALOG):
                result["copied"] += 1
        transaction["state"] = "ready"
        write_json_atomic(marker, transaction)
        ready = True
        config.save({"library_dir": str(dst)})
        committed = True
        return result
    except Exception:
        if not committed:
            rollback_failed = False
            if ready:
                try:
                    transaction["state"] = "rollback"
                    write_json_atomic(marker, transaction)
                except OSError:
                    # 不能把仍标记 ready 的完整目标删成半库；源库和配置仍原样保留。
                    log.exception("回滚标记被锁住，保留完整的目标副本")
                    raise
            # 只移除本次独占创建、身份未变的项；保留合并目标原来的每一个文件。
            for target, device, inode in reversed(created):
                try:
                    info = target.lstat()
                    if _linked(target) or (info.st_dev, info.st_ino) != (device, inode):
                        raise OSError("Migration target changed during rollback")
                    if target.is_dir():
                        shutil.rmtree(target)
                    else:
                        target.unlink()
                except OSError:
                    rollback_failed = True
            for parent in reversed(parents):
                try:
                    parent.rmdir()
                except OSError:
                    rollback_failed = True
            if marker_owned and not rollback_failed:
                try:
                    marker.unlink(missing_ok=True)
                except OSError:
                    log.exception("移除失败迁移的标记失败，继续阻止使用目标")
        raise
    finally:
        def cleanup_warning(message):
            log.warning(message, exc_info=True)
            if committed:
                result.setdefault("warnings", []).append(message)
                result["message"] += "\n" + message

        if committed:
            try:
                marker.unlink()
            except OSError:
                cleanup_warning(tr("迁移已完成，但临时标记 {path} 没删掉，可以手动删", path=str(marker)))
        # 只清理本次在目标下生成的随机 staging；绝不清理源库或目标已有目录。
        try:
            if staging.parent == dst and staging.resolve().parent == dst and staging.name.startswith(STAGING_PREFIX) and not _linked(staging):
                shutil.rmtree(staging)
        except OSError:
            cleanup_warning(tr("临时目录 {path} 没删掉，可以手动删", path=str(staging)))


def _drop_ready_marker(root: Path):
    """接入一个已完整发布的库后，顺手删掉留下的 ready 标记；删不掉也不要紧。"""
    marker = root / MIGRATION_MARKER
    try:
        if marker.exists() and not _linked(marker) and read_json(marker, {}).get("state") == "ready":
            marker.unlink()
    except (OSError, ValueError, AttributeError):
        log.warning("没删掉 ready 标记 %s", marker, exc_info=True)


def cleanup(path: str | Path, current: str | Path) -> dict:
    """清理本机一次没完成的迁移：只删标记里记录的、本次要新建的项和临时目录，目标原有的论文不动。"""
    root = Path(path).resolve()
    marker = root / MIGRATION_MARKER
    if root == Path(current).resolve():
        raise ValueError(tr("不能清理正在使用的文献库"))
    if not marker.exists() or _linked(marker):
        raise ValueError(tr("这里没有需要清理的迁移"))
    data = read_json(marker, {}) or {}
    if data.get("state") == "ready":  # 完整的库，只是标记没删掉
        marker.unlink()
        return {"ok": True, "removed": 0}
    names = list(data.get("entries") or []) + [data.get("staging") or ""]
    names += [p.name for p in root.iterdir() if p.name.startswith(STAGING_PREFIX)]
    removed, failed = 0, []
    for name in dict.fromkeys(n for n in names if n):
        target = (root / name)
        rel = Path(name)
        # 只认标记里写的相对路径，且必须还在这个库里面
        if rel.is_absolute() or ".." in rel.parts or not target.parent.resolve().is_relative_to(root):
            continue
        if not target.exists() and not target.is_symlink():
            continue
        try:
            if _linked(target):
                raise OSError("link")
            shutil.rmtree(target) if target.is_dir() else target.unlink()
            removed += 1
        except OSError:
            failed.append(str(target))
    if failed:
        raise ValueError(tr("这些文件被占用，没删掉，请关掉网盘客户端后重试：{path}", path=failed[0]))
    marker.unlink()
    return {"ok": True, "removed": removed}
