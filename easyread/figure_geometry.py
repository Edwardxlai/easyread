"""从 PDF 图像和矢量路径确定图的范围，题注只用于关联，不限制图所在的栏。"""
from __future__ import annotations

import math
from pathlib import Path

from .log import log


def _bounds(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


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


def _graphics(page, occupied, captions):
    images = []
    for obj in page.images:
        box = _box(obj, page)
        if box and _area(box) < .8 and box[3] > .06 and box[1] < .94 \
                and box[2] - box[0] >= .04 and box[3] - box[1] >= .025 \
                and not (box[2] - box[0] < .2 and box[3] - box[1] < .08 and _covered(box, occupied)):
            # A matched paragraph can enclose a figure when PDF text order crosses
            # columns. Only use that approximate text box to reject small inline images.
            images.append(box)

    paths = []
    for obj in page.lines + page.rects + page.curves:
        box = _box(obj, page)
        if not box or _area(box) >= .8 or box[3] < .06 or box[1] > .94:
            continue
        width, height = box[2] - box[0], box[3] - box[1]
        if width > .65 and height < .004 or height > .75 and width < .004:
            continue  # Page separators, not figure components.
        # Give lines a small area for the text/background exclusion tests.
        box = [max(0, box[0] - .001), max(0, box[1] - .001),
               min(1, box[2] + .001), min(1, box[3] + .001)]
        if _covered(box, occupied + images) or _covered(box, captions, .5) \
                or any(_covered(cap, [box], .8) for cap in captions):
            continue
        paths.append(box)
    vectors = _groups(paths, page.width / page.height, .008)
    return images + [b for b in vectors if b[2] - b[0] >= .045 and b[3] - b[1] >= .025]


def _score(graphic, caption, aspect):
    box = caption["box"]
    # Side captions overlap vertically with the drawing, so either direction is valid.
    if caption.get("caption_pos", "below") == "below":
        if graphic[1] > box[3] + .02:
            return math.inf
    elif graphic[3] < box[1] - .02:
        return math.inf
    return _distance(graphic, box, aspect)


def _page_regions(page, captions, occupied):
    aspect = page.width / page.height
    graphics = _graphics(page, occupied, [c["box"] for c in captions.values()])
    assigned = {bid: [] for bid in captions}
    for graphic in graphics:
        bid = min(captions, key=lambda key: _score(graphic, captions[key], aspect))
        if math.isfinite(_score(graphic, captions[bid], aspect)):
            assigned[bid].append(graphic)

    result = {}
    words = None
    for bid, candidates in assigned.items():
        caption = captions[bid]
        if caption["type"] != "figure" or not candidates:
            continue
        nearest = min(_score(b, caption, aspect) for b in candidates)
        if nearest > .18:
            continue
        selected = [b for b in candidates if _score(b, caption, aspect) <= nearest + .012]
        # A distant top row belongs to the same figure when it connects to the
        # bottom row. Do not require every panel to be near the caption itself.
        while True:
            near = [b for b in candidates if b not in selected and
                    any(_distance(b, chosen, aspect) <= .045 for chosen in selected)]
            if not near:
                break
            selected.extend(near)

        if words is None:
            words = [_box(word, page) for word in page.extract_words()]
            words = [b for b in words if b and not _covered(b, occupied)]
        # Vector plots can put labels just outside their paths. Keep those labels,
        # while excluding body paragraphs and captions belonging to other figures.
        labels = [b for b in words if any(_distance(b, g, aspect) <= .018 for g in selected)
                  and not _covered(b, [c["box"] for key, c in captions.items() if key != bid])]
        bounds = _bounds(selected + labels + [caption["box"]])
        result[bid] = [round(max(0, bounds[0] - .008), 4), round(max(0, bounds[1] - .008), 4),
                       round(min(1, bounds[2] + .008), 4), round(min(1, bounds[3] + .008), 4)]
    return result


def locate_figures(root: Path, blocks: list[dict], layout: dict) -> dict[str, list[float]]:
    """没有可靠图形边界时返回空结果，让原有题注估算规则继续工作。"""
    by_page = {}
    caption_ids = {b.get("id") for b in blocks if b.get("type") in ("figure", "table")}
    for block in blocks:
        loc = layout.get(block.get("id"))
        if block.get("type") not in ("figure", "table") or not loc:
            continue
        by_page.setdefault(loc["page"], {})[block["id"]] = {
            "box": loc["box"], "type": block["type"], "caption_pos": block.get("caption_pos", "below")}
    if not by_page or not (root / "source.pdf").is_file():
        return {}
    import pdfplumber

    result = {}
    try:
        with pdfplumber.open(root / "source.pdf") as pdf:
            for pn, captions in by_page.items():
                if not any(c["type"] == "figure" for c in captions.values()) or not 1 <= pn <= len(pdf.pages):
                    continue
                occupied = [box for bid, loc in layout.items() if bid not in caption_ids and loc["page"] == pn
                            for box in loc.get("boxes") or [loc["box"]]]
                try:
                    result.update(_page_regions(pdf.pages[pn - 1], captions, occupied))
                except Exception:  # noqa: BLE001
                    log.exception("读取 PDF 图形边界失败 %s 第 %s 页", root, pn)
    except Exception:  # noqa: BLE001
        log.exception("读取 PDF 图形边界失败 %s", root)
    return result
