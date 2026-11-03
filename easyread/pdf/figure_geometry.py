"""从 PDF 图像和矢量路径确定图的范围，题注只用于关联，不限制图所在的栏。

模型给的裁剪框（hint）只用来认图：框碰到的图形算这张图的，再按真实边界撑开或收紧；
框没碰到任何图形时照旧按题注找。程序找不到图形边界时由调用方退回模型的框。"""
from __future__ import annotations

import math
from pathlib import Path

from . import figure_pixels, page_margins
from .figures import figure_box
from .paragraph_regions import matched_body_words
from ..app.log import log
from ..library.store import Workspace


def _bounds(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def _overlap(a, b):
    return _area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def _covered(box, regions, fraction=.6):
    area = _area(box)
    return any(_area([max(box[0], b[0]), max(box[1], b[1]),
                      min(box[2], b[2]), min(box[3], b[3])]) >= area * fraction
               for b in regions) if area else False


def _box(obj, page):
    try:
        box = [float(obj[k]) / size for k, size in
               (("x0", page.width), ("top", page.height), ("x1", page.width), ("bottom", page.height))]
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return None
    if not all(math.isfinite(v) for v in box):
        return None
    box = [max(0, min(1, v)) for v in box]
    return box if box[0] <= box[2] and box[1] <= box[3] else None


def _distance(a, b, aspect):
    dx = max(a[0] - b[2], b[0] - a[2], 0) * aspect
    dy = max(a[1] - b[3], b[1] - a[3], 0)
    return math.hypot(dx, dy)


def _groups(boxes, aspect, gap):
    boxes = sorted(boxes, key=lambda b: b[0])
    parents = list(range(len(boxes)))

    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for i, box in enumerate(boxes):
        for j in range(i + 1, len(boxes)):
            other = boxes[j]
            if other[0] > box[2] + gap / aspect:
                break
            if _distance(box, other, aspect) <= gap:
                parents[find(j)] = find(i)
    groups = {}
    for i, box in enumerate(boxes):
        groups.setdefault(find(i), []).append(box)
    return [_bounds(g) for g in groups.values()]


def _blank_fill(obj):
    """只填充不描边、填的是白色（页面底色）的路径：PDF 常用它铺背景，页面上看不见。"""
    color = obj.get("non_stroking_color")
    if not obj.get("fill") or obj.get("stroke") or not isinstance(color, (tuple, list)) or not color:
        return False
    try:
        color = [float(v) for v in color]
    except (TypeError, ValueError):
        return False
    return all(v <= .04 for v in color) if len(color) == 4 else all(v >= .96 for v in color)


def _separator(box):
    width, height = box[2] - box[0], box[3] - box[1]
    return width > .65 and height < .004 or height > .75 and width < .004


def _separators(page):
    """页眉横线、栏间竖线这类分隔线；渲染判断可见范围时也要抹掉，免得图片白边靠它撑到页眉。"""
    boxes = [_box(obj, page) for obj in page.lines + page.rects]
    return [b for b in boxes if b and _separator(b)]


def _clear_gap(a, b, blockers):
    """两块图形之间没有正文或别的题注隔开。"""
    if a[3] <= b[1] or b[3] <= a[1]:
        gap = [min(a[0], b[0]), min(a[3], b[3]), max(a[2], b[2]), max(a[1], b[1])]
    else:
        gap = [min(a[2], b[2]), max(a[1], b[1]), max(a[0], b[0]), min(a[3], b[3])]
    return not any(min(gap[2], c[2]) - max(gap[0], c[0]) > .002 and min(gap[3], c[3]) - max(gap[1], c[1]) > .002
                   for c in blockers)


def _graphics(page, occupied, captions, visible):
    images = []
    for obj in page.images:
        box = _box(obj, page)
        box = visible(box) if box else None  # 图片自带的白边不算图
        if box and _area(box) < .8 and box[3] > .06 and box[1] < .94 \
                and box[2] - box[0] >= .04 and box[3] - box[1] >= .025 \
                and not (box[2] - box[0] < .2 and box[3] - box[1] < .08 and _covered(box, occupied)):
            # A matched paragraph can enclose a figure when PDF text order crosses
            # columns. Only use that approximate text box to reject small inline images.
            images.append(box)

    paths = []
    for obj in page.lines + page.rects + page.curves:
        box = _box(obj, page)
        if not box or _area(box) >= .8 or box[3] < .06 or box[1] > .94 or _blank_fill(obj):
            continue
        if _separator(box):
            continue  # Page separators, not figure components.
        # Give lines a small area for the text/background exclusion tests.
        box = visible([max(0, box[0] - .001), max(0, box[1] - .001),
                       min(1, box[2] + .001), min(1, box[3] + .001)])
        if not box:
            continue  # 被裁剪路径挡住或画成底色，页面上看不见
        if _covered(box, occupied + images) or _covered(box, captions, .5) \
                or any(_covered(cap, [box], .8) for cap in captions):
            continue
        paths.append(box)
    vectors = _groups(paths, page.width / page.height, .008)
    large = [b for b in vectors if b[2] - b[0] >= .045 and b[3] - b[1] >= .025]
    # 太小的组（勾叉记号、虚线分隔）不单独当图，但能像标签一样把图里分开的几块连起来。
    return images + large, [b for b in vectors if b not in large]


def _score(graphic, caption, aspect):
    box = caption["box"]
    # Side captions overlap vertically with the drawing, so either direction is valid.
    if caption.get("caption_pos", "below") == "below":
        if graphic[1] > box[3] + .02:
            return math.inf
    elif graphic[3] < box[1] - .02:
        return math.inf
    return _distance(graphic, box, aspect)


def _page_regions(page, captions, occupied, render, running=(), paragraphs=()):
    aspect = page.width / page.height
    page_words = page.extract_words()
    all_words = [b for b in (_box(word, page) for word in page_words) if b]
    # A paragraph can start on the previous page, or have only its head located
    # in the other column. Recover its actual words before growing figure labels.
    occupied = occupied + [b for b in (_box(word, page) for word in matched_body_words(page_words, paragraphs)) if b]
    separators = _separators(page)
    top, bottom = page_margins.margins(separators, running)
    masks = render(all_words + separators)
    if masks is None:
        return {}  # 渲染不了就无法确认哪些图形看得见，交给题注估算
    mask, ink = masks
    graphics, marks = _graphics(page, occupied, [c["box"] for c in captions.values()],
                                lambda box: figure_pixels.trim(mask, box))
    assigned = {bid: [] for bid in captions}
    for graphic in graphics:
        bid = min(captions, key=lambda key: _score(graphic, captions[key], aspect))
        if math.isfinite(_score(graphic, captions[bid], aspect)):
            assigned[bid].append(graphic)

    result = {}
    # 页眉页脚里的字不能当图的标签。
    words = [b for b in all_words if b[3] > top + .002 and b[1] < bottom - .002
             and not _covered(b, occupied) and figure_pixels.inked(ink, b)]
    marks = [b for b in marks if b[3] > top + .002 and b[1] < bottom - .002]
    for bid, caption in captions.items():
        candidates = assigned[bid]
        if caption["type"] != "figure" or caption.get("fixed"):
            continue
        hint = caption.get("hint")
        # 模型框压到的图形就是这张图（框偏紧时只压到一部分也算），不再按离题注远近挑。
        selected = [g for g in graphics if hint and _overlap(g, hint) >= _area(g) * .3]
        by_hint = bool(selected)
        if by_hint:
            candidates = candidates + [g for g in selected if g not in candidates]
        else:
            if not candidates:
                continue
            nearest = min(_score(b, caption, aspect) for b in candidates)
            if nearest > .18:
                continue
            selected = [b for b in candidates if _score(b, caption, aspect) <= nearest + .012]
        others = [c["box"] for key, c in captions.items() if key != bid]
        # 模型认出的图在题注一侧时，题注另一侧的图形不跟着连进来。
        blockers = occupied + others + ([caption["box"]] if by_hint else [])
        # A distant top row belongs to the same figure when it connects to the
        # bottom row. Do not require every panel to be near the caption itself.
        # 隔着空白、但中间没有正文的上一排子图也算同一张图。
        while True:
            near = [b for b in candidates if b not in selected and
                    any(_distance(b, chosen, aspect) <= .045 or _distance(b, chosen, aspect) <= .2
                        and _clear_gap(b, chosen, blockers) for chosen in selected)]
            if not near:
                break
            selected.extend(near)

        # Vector plots can put labels just outside their paths. Keep those labels,
        # while excluding body paragraphs and captions belonging to other figures.
        # 标签可以一个挨一个连出去（图里的小标题、坐标轴说明常是 PDF 文字）。
        # A single-column drawing and its caption establish a column boundary.
        # Label flood-fill must not jump the gutter into neighboring prose.
        anchor = _bounds(selected + [caption["box"]])
        left, right = (0., .5) if anchor[2] <= .5 else ((.5, 1.) if anchor[0] >= .5 else (0., 1.))
        labels, pending = [], [b for b in words + marks if not _covered(b, others)
                               and b[0] >= left and b[2] <= right]
        while True:
            near = [b for b in pending if any(_distance(b, g, aspect) <= .03 for g in selected + labels)]
            if not near:
                break
            labels.extend(near)
            pending = [b for b in pending if b not in near]
        bounds = _bounds(selected + labels + [caption["box"]])
        cap, drawing = caption["box"], _bounds(selected)
        # 截图只要图本身：题注那几行字已经作为文字显示在图下面了。
        crop = _bounds(selected + [b for b in labels if not _covered(b, [cap], .5)])
        # 题注整个在图下方（或上方）时，图框不越过题注继续往外扩；侧边题注和图上下重叠，不受限。
        # 截图另外再看题注是不是压在图片的底边（顶边）上：横向和图对齐、落在图的下半（上半）就截到题注为止。
        aligned = min(cap[2], drawing[2]) - max(cap[0], drawing[0]) >= (cap[2] - cap[0]) * .5
        middle = (drawing[1] + drawing[3]) / 2
        if caption.get("caption_pos", "below") == "below":
            if cap[1] >= drawing[3] - .01:
                bounds[3] = cap[3]
            if cap[1] >= drawing[3] - .01 or aligned and cap[1] > middle:
                crop[3] = min(crop[3], cap[1] - .008)
        else:
            if cap[3] <= drawing[1] + .01:
                bounds[1] = cap[1]
            if cap[3] <= drawing[1] + .01 or aligned and cap[3] < middle:
                crop[1] = max(crop[1], cap[3] + .008)
        result[bid] = {"box": _padded(bounds), "crop": _padded(crop)}
    return result


def _padded(box):
    return [round(max(0, box[0] - .008), 4), round(max(0, box[1] - .008), 4),
            round(min(1, box[2] + .008), 4), round(min(1, box[3] + .008), 4)]


def _oversized_form(page) -> bool:
    """Reject tiled pages before a PDF layout engine expands their shared canvas.

    Paginated web exports can nest an entire book in every page's Form XObject.
    Reading Form dictionaries is cheap; extracting that Form's text/paths is not.
    Account for Form matrices so ordinary scaled artwork keeps its geometry.
    The conservative fallback also bounds cyclic/deep resource graphs.
    """
    def resolved(value):
        return value.get_object() if hasattr(value, "get_object") else value

    width, height = float(page.cropbox.width), float(page.cropbox.height)
    pending = [(resolved(page.get("/Resources", {})), (1., 0., 0., 1.), frozenset())]
    seen = set()
    while pending:
        resources, parent, ancestors = pending.pop()
        objects = resolved(resources.get("/XObject", {}))
        for ref in objects.values():
            form = resolved(ref)
            if form.get("/Subtype") != "/Form":
                continue
            identity = id(form)
            if identity in ancestors or len(ancestors) >= 32:
                return True
            matrix = [float(v) for v in form.get("/Matrix", [1, 0, 0, 1, 0, 0])]
            box = [float(v) for v in form.get("/BBox", [])]
            if len(matrix) != 6 or len(box) != 4 or not all(math.isfinite(v) for v in matrix + box):
                return True
            a, b, c, d = parent
            x, y, z, w = matrix[:4]
            transform = (a*x + c*y, b*x + d*y, a*z + c*w, b*z + d*w)
            key = (identity, transform)
            if key in seen:
                continue
            seen.add(key)
            if len(seen) > 128:
                return True
            fw, fh = abs(box[2] - box[0]), abs(box[3] - box[1])
            a, b, c, d = transform
            if abs(a)*fw + abs(c)*fh > width * 4 or abs(b)*fw + abs(d)*fh > height * 4:
                return True
            pending.append((resolved(form.get("/Resources", {})), transform, ancestors | {identity}))
    return False


def _unsafe_pages(path: Path, pages) -> set[int]:
    """Inspect only candidate pages, without decompressing Form content streams."""
    from pypdf import PdfReader

    pages = set(pages)
    try:
        with path.open("rb") as source:
            pdf = PdfReader(source)
            return {pn for pn in pages if 1 <= pn <= len(pdf.pages) and _oversized_form(pdf.pages[pn - 1])}
    except Exception:  # noqa: BLE001
        log.exception("检查 PDF 图形资源失败 %s", path)
        return pages  # 无法确认安全时保留题注估算，不展开未知的大画布。


def locate_figures(root: Path, blocks: list[dict], layout: dict) -> dict[str, dict]:
    """{块 id: {"box": 原页上图连题注的范围, "crop": 截图用的图本身范围}}。
    没有可靠图形边界时不返回这张图，让调用方用模型的框或题注估算。"""
    by_page = {}
    caption_ids = {b.get("id") for b in blocks if b.get("type") in ("figure", "table")}
    for block in blocks:
        loc = layout.get(block.get("id"))
        if block.get("type") not in ("figure", "table") or not loc:
            continue
        hint = figure_box(block.get("box")) if block.get("page") == loc["page"] else None
        by_page.setdefault(loc["page"], {})[block["id"]] = {
            "box": loc["box"], "type": block["type"], "caption_pos": block.get("caption_pos", "below"),
            "fixed": loc.get("src") == "manual", "hint": hint}
    # Keep fixed captions as blockers only on pages with a figure that needs work.
    by_page = {pn: captions for pn, captions in by_page.items()
               if any(c["type"] == "figure" and not c["fixed"] for c in captions.values())}
    if not by_page:
        return {}
    source = Workspace(root).source_pdf
    if not source.is_file():
        return {}
    unsafe = _unsafe_pages(source, by_page)
    by_page = {pn: captions for pn, captions in by_page.items() if pn not in unsafe}
    if not by_page:
        return {}
    import pdfplumber

    result = {}
    try:
        with pdfplumber.open(source) as pdf:
            running = page_margins.running_lines(root / "extract", len(pdf.pages))
            for pn, captions in by_page.items():
                if not any(c["type"] == "figure" for c in captions.values()) or not 1 <= pn <= len(pdf.pages):
                    continue
                from .caption_extent import page_locs
                occupied = [loc["box"] for loc in page_locs(
                    {bid: loc for bid, loc in layout.items() if bid not in caption_ids}, pn)]
                def render(erase, pn=pn):
                    try:
                        return figure_pixels.visible_mask(source, pn - 1, erase)
                    except Exception:  # noqa: BLE001
                        log.exception("渲染原页失败 %s 第 %s 页", root, pn)
                        return None
                page = pdf.pages[pn - 1]
                from .pdfwork import block_english  # link targets in en are not printed on the page
                paragraphs = [block_english(block) for block in blocks if block.get("type") in ("para", "list", "heading")
                              and block.get("page") in (pn - 1, pn)]
                try:
                    result.update(_page_regions(page, captions, occupied, render, running.get(pn, ()), paragraphs))
                except Exception:  # noqa: BLE001
                    log.exception("读取 PDF 图形边界失败 %s 第 %s 页", root, pn)
                finally:
                    page.close()  # pdfplumber caches the whole parsed layout until explicitly closed.
    except Exception:  # noqa: BLE001
        log.exception("读取 PDF 图形边界失败 %s", root)
    return result
