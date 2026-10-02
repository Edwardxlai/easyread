"""图块截图。两条路：

- 翻译 / 只读原文整理时，模型给了图本身的裁剪框 box：等块 id 在合并锁里最终去重之后，
  prepare_figures 按 box 截图（normalize_figure 只整理字段，不截图）。
- 模型没给框、或是旧论文：打开阅读页时 fill_later 按原页定位（layout.json）补截或更新自动截图。

截图文件名带上页码、框和 PDF 文件身份的哈希（figures/crop-<页>-<哈希>.webp）：
重译改了框就换新文件，不会沿用旧图或浏览器缓存，同 id 的块在别的页上也不会撞到同一张。
"""
from __future__ import annotations

import hashlib
import json
import math
import threading

from . import pdfwork
from .log import log

_running: set[str] = set()


def figure_box(value) -> list[float] | None:
    """归一化 [x0, y0, x1, y1]；不是有限数、反了或太小都算无效。"""
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        coords = [float(x) for x in value]
    except (TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(x) for x in coords):
        return None
    box = [round(max(0.0, min(1.0, x)), 4) for x in coords]
    if box[2] - box[0] < .02 or box[3] - box[1] < .02:
        return None
    return box


def _crop_path(root, page: int, box: list[float]) -> str:
    source = (root / "source.pdf").stat()
    identity = json.dumps([page, box, source.st_size, source.st_mtime_ns])
    name = f"crop-{page}-{hashlib.sha256(identity.encode()).hexdigest()[:20]}"
    return f"figures/{name}.webp"


def crop(root, page: int, box: list[float]) -> str:
    """按页码、框和 PDF 身份命名截图，已有同名文件就直接用。返回相对路径。"""
    rel = _crop_path(root, page, box)
    if not (root / rel).is_file():
        pdfwork.crop(root, page, box, rel.rsplit("/", 1)[1][:-5])
    return rel


def normalize_figure(block: dict) -> None:
    """整理模型给的图块字段：框无效就去掉，image_text_* 旧写法改成 image_*。不截图。"""
    box = figure_box(block.get("box"))
    if box:
        block["box"] = box
    else:
        block.pop("box", None)
    for lang in ("en", "zh"):
        key = f"image_{lang}"
        value = block.get(key) or block.pop(f"image_text_{lang}", "")
        if value:
            block[key] = str(value).strip()


def prepare_figures(root, blocks: list[dict], total_pages: int) -> None:
    """在合并锁里、最后一次 id 去重之后调用：有 box 的图块重新截图。
    截不了（页码不对、框无效、截图失败）就清掉 src 和 box，留给原页入口和 fill_later。没 box 的块不动。"""
    for block in blocks:
        if block.get("type") != "figure" or not block.get("box"):
            continue
        block["src"] = ""
        page, box = block.get("page"), figure_box(block["box"])
        if not box or not isinstance(page, int) or not 1 <= page <= total_pages:
            block.pop("box", None)
            continue
        try:
            block["src"] = crop(root, page, box)
        except Exception:  # noqa: BLE001
            block.pop("box", None)
            log.exception("截图失败 %s 第 %s 页", block.get("id"), page)


def _pending(ws):
    """没有截图或自动裁剪范围已变化的图块；保留显式 box 和自定义 src。"""
    layout = ws.load("layout") or {}
    out = []
    for b in (ws.load("paper") or {}).get("blocks", []):
        src = b.get("src", "")
        if b.get("type") != "figure" or src and (b.get("box") or not src.startswith("figures/crop-")):
            continue
        loc = layout.get(b.get("id")) or {}
        box = figure_box(loc.get("box"))
        page = loc.get("page")
        if not box or not isinstance(page, int) or page < 1:
            continue
        x0, y0, x1, y1 = box
        if x1 - x0 < 0.05 or y1 - y0 < 0.03:  # 只匹配到一行题注、没撑开的框截出来没用
            continue
        if src:
            try:
                if src == _crop_path(ws.root, page, box) and (ws.root / src).is_file():
                    continue
            except OSError:
                continue  # PDF 不在时保留已经存在的截图。
        out.append((b, page, box))
    return out


def missing(ws) -> list[tuple[str, int, list[float]]]:
    """需要补截或更新自动截图的图块：[(块 id, 页码, 框)]。"""
    return [(b["id"], page, box) for b, page, box in _pending(ws)]


def fill(ws) -> int:
    """补截或更新自动截图；写回时保留截图期间发生的编辑和重译。"""
    done = {}
    for block, page, box in _pending(ws):
        try:
            done[block["id"]] = (block, crop(ws.root, page, box))
        except Exception:  # noqa: BLE001
            log.exception("截图失败 %s %s", ws.root, block["id"])
    if done:
        def apply(paper):
            count = 0
            for b in paper.get("blocks", []):
                previous, src = done.get(b.get("id"), (None, None))
                if b == previous:
                    b["src"] = src
                    count += 1
            return count
        return ws.update("paper", apply)
    return 0


def fill_later(ws, gate=None) -> None:
    """打开阅读页时在后台补；补完 paper.json 变了，页面轮询到就会重画。"""
    key = str(ws.root)
    if key in _running or not missing(ws):
        return
    if gate:
        gate.begin()
    _running.add(key)

    def run():
        try:
            fill(ws)
        finally:
            _running.discard(key)
            if gate:
                gate.end()
    threading.Thread(target=run, daemon=True).start()
