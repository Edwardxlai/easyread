"""Save generated PDFs to a user-selected directory without replacing files."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path


def output_directory(value: str) -> Path | None:
    if not value:
        return None
    folder = Path(value).expanduser()
    if not folder.is_absolute() or not folder.is_dir():
        raise ValueError("请选择已存在的输出目录")
    folder = folder.resolve()
    try:
        with tempfile.TemporaryFile(dir=folder):
            pass
    except OSError as exc:
        raise ValueError("输出目录无法写入，请选择其他文件夹") from exc
    return folder


def copy_pdf(source: Path, folder: Path) -> Path:
    for number in range(1, 10001):
        name = source.name if number == 1 else f"{source.stem} ({number}){source.suffix}"
        destination = folder / name
        try:
            target = destination.open("xb")
        except FileExistsError:
            continue
        try:
            with target, source.open("rb") as original:
                shutil.copyfileobj(original, target)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return destination
    raise ValueError("输出目录中同名文件过多，请选择其他文件夹")
