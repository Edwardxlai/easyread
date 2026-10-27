"""图块截图。两条路：

- 翻译 / 只读原文整理时，模型给了图本身的裁剪框 box：等块 id 在合并锁里最终去重之后，
  prepare_figures 先按 box 截一张（normalize_figure 只整理字段，不截图）。
- 定位（layout.json）之后 fill 按原页定位补截或更新截图：PDF 图形边界认出了这张图就以它为准
  （模型的框只用来认图，常常偏紧或偏松），认不出时 layout 里就是模型的框。

截图文件名带上页码、框和 PDF 文件身份的哈希（figures/crop-<页>-<哈希>.webp）：
重译改了框就换新文件，不会沿用旧图或浏览器缓存，同 id 的块在别的页上也不会撞到同一张。
换新文件后旧截图如果没有别处引用（含手动裁剪快照里留档的 src），fill 会顺手清掉。
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading

from . import pdfwork
from ..app.log import log
from ..library.store import Workspace

_running: set[str] = set()

_CROP_NAME = re.compile(r"crop-\d+-[0-9a-f]{20}\.webp\Z")


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
    source = Workspace(root).source_pdf.stat()
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
    截不了（页码不对、框无效、截图失败）就清掉 src 和 box，留给原页入口和 fill_later。没 box 的块不动。
    abox 始终是当前 src 那张截图实际用的框，阅读页按它占原页的比例给图定宽。"""
    for block in blocks:
        if block.get("type") != "figure" or not block.get("box"):
            continue
        block["src"] = ""
        block.pop("abox", None)
        page, box = block.get("page"), figure_box(block["box"])
        if not box or not isinstance(page, int) or not 1 <= page <= total_pages:
            block.pop("box", None)
            continue
        try:
            block["src"] = crop(root, page, box)
            block["abox"] = box
        except Exception:  # noqa: BLE001
            block.pop("box", None)
            log.exception("截图失败 %s 第 %s 页", block.get("id"), page)


def _pending(ws):
    """没有截图、自动裁剪范围已变化或缺 abox 的图块；保留自定义 src。"""
    layout = ws.load("layout") or {}
    out = []
    for b in (ws.load("paper") or {}).get("blocks", []):
        src = b.get("src", "")
        if b.get("type") != "figure" or "manual_crop" in b or src and not src.startswith("figures/crop-"):
            continue
        loc = layout.get(b.get("id")) or {}
        box = figure_box(loc.get("crop") or loc.get("box"))
        page = loc.get("page")
        if not box or not isinstance(page, int) or page < 1:
            continue
        x0, y0, x1, y1 = box
        if x1 - x0 < 0.05 or y1 - y0 < 0.03:  # 只匹配到一行题注、没撑开的框截出来没用
            continue
        if src:
            try:
                if src == _crop_path(ws.root, page, box) and (ws.root / src).is_file():
                    if b.get("abox") == list(box):
                        continue  # 截图和框都已是最新
                    out.append((b, page, box))  # 只缺 abox：crop 命中缓存，零成本回填
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
            done[block["id"]] = (block, page, box, crop(ws.root, page, box))
        except Exception:  # noqa: BLE001
            log.exception("截图失败 %s %s", ws.root, block["id"])
    if done:
        stale: set[str] = set()

        def apply(paper):
            count = 0
            for b in paper.get("blocks", []):
                done_item = done.get(b.get("id"))
                if done_item and b == done_item[0]:
                    _, page, box, src = done_item
                    if b.get("src") and b["src"] != src:
                        stale.add(b["src"])
                    b["src"] = src
                    b["abox"] = list(box)  # 截图实际用的框（不含题注），前端按它占原页的比例定宽；box 仍是模型给的框
                    count += 1
            return count
        count = ws.update("paper", apply)
        _drop_orphans(ws, stale)
        return count
    return 0


def _figure_srcs(paper) -> set[str]:
    """paper.json 里指向截图的所有引用：块 src，加上手动裁剪快照里留档的旧 src（reset 要恢复它）。"""
    out = set()
    for b in paper.get("blocks", []):
        out.add(b.get("src", ""))
        snapshot = b.get("manual_crop")
        if isinstance(snapshot, dict):
            out.add(snapshot.get("src", ""))
    return out


def _drop_orphans(ws, stale: set[str]) -> None:
    """src 换新截图后清掉不再被引用的旧自动截图：定位修正、重译换框都会留下孤儿文件。
    引用以清理那一刻的 paper.json 为准，只删自动裁剪命名的文件；删不掉就留着，无害。"""
    if not stale:
        return
    try:
        referenced = _figure_srcs(ws.load("paper"))
    except Exception:  # noqa: BLE001
        return
    for src in stale:
        if src in referenced or not src.startswith("figures/"):
            continue
        if not _CROP_NAME.fullmatch(src.rsplit("/", 1)[-1]):
            continue
        try:
            (ws.root / src).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            log.exception("清理旧截图失败 %s", src)


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
