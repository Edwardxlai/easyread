"""PDF 相关的机械活：渲染原页、抽文字和字符坐标、裁图、给译文段落定位原页区域。

这里不做任何翻译，也不调用模型。
"""
from __future__ import annotations

import json
import re
import threading
import unicodedata
from contextlib import closing, contextmanager
from functools import lru_cache
from pathlib import Path
from statistics import median

from ..translate import float_order
from .caption_extent import column as _column, overlap_x as _overlap_x, page_locs as _page_locs
from .caption_extent import extend_captioned as _extend_captioned
from .text_regions import locate_prose
from .render_limits import render_page
from ..library.store import Workspace, write_json_atomic

# PDFium is not thread-safe, even when threads open separate documents.
# Keep native handles and their cleanup inside the same process-wide lock.
_PDFIUM_LOCK = threading.RLock()
_LAYOUT_LOCK = threading.RLock()


@contextmanager
def open_pdf(pdf: Path):
    """所有 PDFium 调用与资源释放共用一把锁，包括操作不同文档的线程。"""
    import pypdfium2 as pdfium
    with _PDFIUM_LOCK, closing(pdfium.PdfDocument(str(pdf))) as doc:
        yield doc


def render_pages(pdf: Path, out_dir: Path, scale: float = 2.4, quality: int = 84, *, reopen: bool = False) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = []
    from contextlib import ExitStack
    with ExitStack() as stack:
        doc = stack.enter_context(open_pdf(pdf))
        count = len(doc)
        if reopen:
            stack.close()
        for i in range(count):
            page_stack = ExitStack()
            if reopen:
                doc = page_stack.enter_context(open_pdf(pdf))
            with page_stack, closing(doc[i]) as page, closing(render_page(page, scale)) as bitmap:
                w, h = page.get_size()
                with bitmap.to_pil() as raw, raw.convert("RGB") as img:
                    name = f"page-{i + 1:03d}.webp"
                    img.save(out_dir / name, "WEBP", quality=quality, method=5)
                pages.append({"n": i + 1, "w": round(w, 2), "h": round(h, 2), "img": f"pages/{name}"})
    return pages


def extract_text(pdf: Path, out_dir: Path) -> int:
    """每页一份 .txt（给 agent 读）和 .chars.json（给定位用，坐标按页宽高归一化）。"""
    from pypdfium2 import raw as pdfium_c

    out_dir.mkdir(parents=True, exist_ok=True)
    with open_pdf(pdf) as doc:
        for i in range(len(doc)):
            with closing(doc[i]) as page, closing(page.get_textpage()) as tp:
                # A tiled PDF can reference the entire source document on every
                # page. Unbounded text includes the off-page content; pdfplumber
                # also builds and retains a full Python layout for every tile.
                # Use one native text page for both outputs and close it eagerly.
                text = tp.get_text_bounded()
                bounds, rotation = page.get_bbox(), page.get_rotation()
                chars = []
                count = tp.count_chars()
                for index in range(count):
                    box = _char_box(tp.get_charbox(index, loose=True), bounds, rotation)
                    if box is None:
                        continue
                    # Indexing get_text_range() is unsafe: its string indices can
                    # differ from PDFium's character indices (generated newlines,
                    # unmapped glyphs, and non-BMP Unicode characters).
                    code = pdfium_c.FPDFText_GetUnicode(tp, index)
                    if 0xD800 <= code <= 0xDBFF and index + 1 < count:
                        low = pdfium_c.FPDFText_GetUnicode(tp, index + 1)
                        if 0xDC00 <= low <= 0xDFFF:
                            code = 0x10000 + ((code - 0xD800) << 10) + low - 0xDC00
                    if not code or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
                        continue
                    char = chr(code)
                    if char in "\r\n":
                        continue
                    chars.append([char, *box])
                (out_dir / f"page-{i + 1:03d}.txt").write_text(text, encoding="utf-8")
                (out_dir / f"page-{i + 1:03d}.chars.json").write_text(json.dumps(chars, ensure_ascii=False), encoding="utf-8")
        return len(doc)


def _char_box(box, bounds, rotation: int) -> list[float] | None:
    """PDF canvas -> rendered page, respecting CropBox origin and page rotation."""
    l, b, r, t = box
    L, B, R, T = bounds
    if r <= L or l >= R or t <= B or b >= T:
        return None
    x0, y0 = (max(l, L) - L) / (R - L), (T - min(t, T)) / (T - B)
    x1, y1 = (min(r, R) - L) / (R - L), (T - max(b, B)) / (T - B)
    if rotation == 90:
        x0, y0, x1, y1 = 1 - y1, x0, 1 - y0, x1
    elif rotation == 180:
        x0, y0, x1, y1 = 1 - x1, 1 - y1, 1 - x0, 1 - y0
    elif rotation == 270:
        x0, y0, x1, y1 = y0, 1 - x1, y1, 1 - x0
    return [round(v, 4) for v in (x0, y0, x1, y1)]


def crop(root: Path, page: int, box: list[float], out_name: str, scale: float = 3.0) -> str:
    """box 是按页宽高归一化的 [x0, y0, x1, y1]；输出到 figures/，返回相对路径。"""
    with open_pdf(Workspace(root).source_pdf) as doc:
        with closing(doc[page - 1]) as pdf_page, closing(render_page(pdf_page, scale)) as bitmap:
            with bitmap.to_pil() as raw, raw.convert("RGB") as img:
                W, H = img.size
                x0, y0, x1, y1 = box
                with img.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))) as part:
                    (root / "figures").mkdir(exist_ok=True)
                    rel = f"figures/{out_name}.webp"
                    part.save(root / rel, "WEBP", quality=90)
    return rel


# ---------- 定位：译文段落 -> 原页区域 ----------

_MATH = re.compile(r"\$[^$]*\$")
_ALNUM = re.compile(r"[a-z0-9]")
LOCATE_VERSION = "10"  # 正文保存跨栏、跨页的多个实测区域；旧论文打开时重算一次。


def _norm(s: str) -> str:
    return "".join(_ALNUM.findall(unicodedata.normalize("NFKC", s).lower()))


def _page_stream(extract_dir: Path, n: int):
    path = extract_dir / f"page-{n:03d}.chars.json"
    if not path.exists():
        return None
    chars = json.loads(path.read_text(encoding="utf-8"))
    text, idx = [], []
    for k, c in enumerate(chars):
        for t in _norm(c[0]):  # 连字 ﬁ/ﬂ 会展开成两个字母，指向同一个字符框
            text.append(t)
            idx.append(k)
    return "".join(text), idx, chars


def _anchors(en: str) -> tuple[str, str]:
    plain_parts = [p for p in _MATH.split(en) if _norm(p)]
    if not plain_parts:
        return "", ""
    head = _norm(plain_parts[0])[:28]
    tail = _norm(plain_parts[-1])[-28:]
    return head, tail


def _box(chars, idx, a: int, b: int):
    sel = [chars[idx[k]] for k in range(a, min(b, len(idx) - 1) + 1)]
    return [min(c[1] for c in sel), min(c[2] for c in sel), max(c[3] for c in sel), max(c[4] for c in sel)]


def _bounds(boxes: list[list[float]]) -> list[float]:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _boxes(chars, idx, a: int, b: int) -> list[list[float]]:
    """保留栏间空白：横向不相连的字符分组各有一个框，而不是取整段的外接框。"""
    selected = [chars[i][1:5] for i in set(idx[a:min(b + 1, len(idx))])]
    selected = [box for box in selected if box[2] > box[0] and box[3] > box[1]]
    if not selected:
        return [_box(chars, idx, a, b)]
    gap = max(0.008, median(box[2] - box[0] for box in selected) * 2.5)
    boxes = []
    for box in sorted(selected, key=lambda box: box[0]):
        if not boxes or box[0] > boxes[-1][2] + gap:
            boxes.append(list(box))
        else:
            boxes[-1] = _bounds([boxes[-1], box])
    return boxes


_MD_LINK = re.compile(r"\[((?:\\.|[^\]\\\n])*)\]\([^)\s]*\)")


def block_english(block: dict) -> str:
    """The block's original text as printed: link targets ([words](#tab:3), [words](https://…)) are not on the page."""
    if block.get("type") == "list":
        text = " ".join(it.get("en", "") for it in block.get("items", []))
    elif block.get("type") in ("table", "figure"):
        text = block.get("caption_en", "")
    else:
        text = block.get("en", "")
    return _MD_LINK.sub(lambda m: m.group(1), text or "")


def locate(root: Path) -> dict:
    with _LAYOUT_LOCK:
        return _locate(root)


def _locate(root: Path) -> dict:
    paper = json.loads((root / "paper.json").read_text(encoding="utf-8"))
    extract_dir = root / "extract"
    # Blocks may arrive out of page order during parallel translation. Keep only
    # the current/next page streams instead of retaining a whole book's chars.
    @lru_cache(maxsize=2)
    def stream(n):
        return _page_stream(extract_dir, n)

    layout: dict[str, dict] = {}
    cursor: dict[int, int] = {}
    for block in paper.get("blocks", []):
        bid, page = block.get("id"), block.get("page")
        if not bid or not page:
            continue
        manual = {"page": page, "box": block["box"], "src": "manual"} if block.get("box") else None
        if manual and block.get("type") != "figure":
            layout[bid] = manual
            continue
        if block.get("type") in ("para", "list"):
            prose = locate_prose(block_english(block), page, stream)
            if prose:
                layout[bid] = prose
                continue
        head, tail = _anchors(block_english(block))
        if not head:
            if manual:  # 没有题注可找：只能按模型给的框
                layout[bid] = manual
            continue
        heads = [head]
        if block.get("type") == "heading" and block.get("num"):
            heads.insert(0, _anchors(f"{block['num']} {block.get('en', '')}")[0])
        for pn in (page, page + 1):
            st = stream(pn)
            if not st:
                continue
            text, idx, chars = st
            a = -1
            for h in heads:
                a = text.find(h, cursor.get(pn, 0) if pn == page else 0)
                if a < 0:
                    a = text.find(h)
                if a >= 0:
                    break
            if a < 0:
                continue
            b = text.find(tail, a) if tail else -1
            end = b + len(tail) - 1 if b >= 0 else min(a + len(_norm(block_english(block))), len(idx) - 1)
            boxes = _boxes(chars, idx, a, end)
            layout[bid] = {"page": pn, "box": _bounds(boxes), "src": "text" if b >= 0 else "head"}
            if len(boxes) > 1:
                layout[bid]["boxes"] = boxes
            cursor[pn] = end
            break
        else:
            if manual:
                layout[bid] = manual
    _extend_captioned(paper.get("blocks", []), layout, root)
    _clamp_overlaps(layout)
    ids = float_order.order(paper.get("blocks", []), layout)
    if ids:  # 图表挪回原页位置；公式的估算框按块顺序算，要在这之后
        paper = Workspace(root).update("paper", lambda p: (float_order.apply(p, ids), p)[1])
    _fill_gaps(paper.get("blocks", []), layout)
    write_json_atomic(root / "layout.json", layout)
    (extract_dir / "locate.version").write_text(LOCATE_VERSION, encoding="utf-8")
    return layout


def refresh_layout(root: Path) -> None:
    """沿用上游的版本标记；并发打开同一篇论文时只重算一次。"""
    with _LAYOUT_LOCK:
        marker = root / "extract" / "locate.version"
        if not (root / "layout.json").exists() or not (root / "paper.json").exists():
            return
        if not any((root / "extract").glob("page-*.chars.json")):
            return
        if marker.exists() and marker.read_text(encoding="utf-8").strip() == LOCATE_VERSION:
            return
        locate(root)


def _clamp_overlaps(layout: dict):
    """只匹配到开头的块按长度估了结尾，可能压到同一栏的下一块；截到它的上沿。"""
    by_page = {page: _page_locs(layout, page) for page in {loc["page"] for loc in layout.values()}}
    for locs in by_page.values():
        locs.sort(key=lambda l: l["box"][1])
        for i, cur in enumerate(locs):
            if cur["src"] not in ("head", "text") or cur["_parent"].get("regions"):
                continue
            nxt = next((l for l in locs[i + 1:] if l["_parent"] is not cur["_parent"]
                        and _overlap_x(l["box"], cur["box"][0], cur["box"][2])
                        and l["box"][1] > cur["box"][1]), None)
            if nxt and cur["box"][3] > nxt["box"][1]:
                cur["box"][3] = round(nxt["box"][1] - 0.002, 4)
    for loc in layout.values():
        if loc.get("boxes"):
            loc["box"] = _bounds(loc["boxes"])


def _fill_gaps(blocks: list[dict], layout: dict):
    """公式这类没有英文可匹配的块：放在同一栏里下一块之上、上方最近一块之下。"""
    for i, block in enumerate(blocks):
        bid = block.get("id")
        if not bid or bid in layout or not block.get("page"):
            continue
        page = block["page"]
        locs = _page_locs(layout, page)
        def on_page(b):
            loc = layout.get(b.get("id"))
            parts = _page_locs({"block": loc}, page) if loc else []
            return {**loc, "page": page, "boxes": [p["box"] for p in parts]} if parts else None
        prev = next((loc for b in reversed(blocks[:i]) if (loc := on_page(b))), None)
        nxt = next((loc for b in blocks[i + 1:] if (loc := on_page(b))), None)
        if prev and prev.get("boxes"):
            prev = {**prev, "box": prev["boxes"][-1]}
        if nxt and nxt.get("boxes"):
            nxt = {**nxt, "box": nxt["boxes"][0]}
        ref = prev or nxt
        col = _column(locs, ref["box"]) if ref else None
        x0, x1 = col if col else (0.12, 0.88)
        if nxt and not _overlap_x(nxt["box"], x0, x1):
            nxt = None  # 下一块在另一栏，不能拿它当下沿
        bottom = nxt["box"][1] if nxt else 0.92
        above = [l["box"][3] for l in locs if _overlap_x(l["box"], x0, x1) and l["box"][3] <= bottom + 0.001]
        top = max(above) if above else 0.08
        if bottom - top < 0.01:
            bottom = top + 0.04
        layout[bid] = {"page": page, "box": [x0, round(top, 4), x1, round(bottom, 4)], "src": "between"}


def engine_image(root: Path, n: int) -> Path:
    """给翻译模型看的原页图（JPEG，模型工具普遍支持），按需生成。"""
    out = root / "extract" / f"page-{n:03d}.jpg"
    with _PDFIUM_LOCK:
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            with open_pdf(Workspace(root).source_pdf) as doc:
                with closing(doc[n - 1]) as page, closing(render_page(page, 2.0)) as bitmap:
                    with bitmap.to_pil() as raw, raw.convert("RGB") as img:
                        img.save(out, "JPEG", quality=82)
    return out


def page_variant(root: Path, rel: str, width: int) -> Path | None:
    """原页图的缩小版（原图 2.4 倍渲染、约 1500 像素宽，右侧面板用不着那么大）。生成一次缓存在 pages/w{宽}/。"""
    width = max(400, min(2000, width // 100 * 100))
    src = (root / rel).resolve()
    if not src.is_relative_to((root / "pages").resolve()) or not src.is_file():
        return None
    out = root / "pages" / f"w{width}" / src.name
    if not out.exists():
        from PIL import Image
        out.parent.mkdir(exist_ok=True)
        with Image.open(src) as im:
            if im.width <= width:
                return src
            im.resize((width, round(im.height * width / im.width)), Image.LANCZOS).save(out, "WEBP", quality=80, method=4)
    return out


PANEL_WIDTH = 1000  # 原页面板默认要的宽度（阅读页按面板宽度只会要 1000 或 1600）


def warm_variants(root: Path, width: int = PANEL_WIDTH) -> None:
    """后台把整篇的面板图都先生成好，打开原页面板时不用等。"""
    pages_dir = root / "pages"
    if not pages_dir.exists():
        return
    for src in sorted(pages_dir.glob("page-*.webp")):
        if not (root / "pages" / f"w{width}" / src.name).exists():
            page_variant(root, f"pages/{src.name}", width)


def prepare(root: Path) -> list[dict]:
    """渲染原页 + 抽文字，返回 meta.pages。"""
    from .prepare_worker import prepare_isolated
    # Serialize with in-process PDF work, too, rather than doubling peak memory.
    with _PDFIUM_LOCK:
        return prepare_isolated(root)
