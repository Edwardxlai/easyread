"""图和表的原页范围：题注定位之后，往外扩到整张图或整张表。

图优先用 PDF 图形边界（figure_geometry），表格和认不出图形的图按题注所在栏估算。
栏和重叠判断的小工具 pdfwork 截重叠、补公式框时也用。"""
from __future__ import annotations

from pathlib import Path


def overlap_x(a: list, x0: float, x1: float) -> bool:
    return max(a[0], x0) < min(a[2], x1) - 0.01


def column(locs: list[dict], box: list) -> tuple[float, float] | None:
    """双栏页上 box 所在那一栏的左右边界；单栏页或 box 本身横跨两栏时返回 None。"""
    left = [l["box"] for l in locs if l["box"][2] <= 0.55]
    right = [l["box"] for l in locs if l["box"][0] >= 0.45]
    if len(left) < 2 or len(right) < 2 or box[2] - box[0] > 0.5:
        return None
    col = right if (box[0] + box[2]) / 2 >= 0.5 else left
    return min(b[0] for b in col), max(b[2] for b in col)


def page_locs(layout: dict, page: int) -> list[dict]:
    return [{"page": page, "box": box, "src": loc["src"], "_parent": loc}
            for loc in layout.values()
            for region in loc.get("regions") or [{"page": loc["page"], "box": box}
                                                 for box in loc.get("boxes") or [loc["box"]]]
            if region["page"] == page for box in [region["box"]]]


def extend_captioned(blocks: list[dict], layout: dict, root: Path | None = None, stream=None):
    """图优先用 PDF 图形边界（模型给的框只用来认图）；认不出时用模型的框，没有框再按题注所在栏估算。"""
    from .figure_geometry import locate_figures
    from . import numbered_listings
    visual = locate_figures(root, blocks, layout) if root else {}
    listing_pages = {}
    for block in blocks:
        loc = layout.get(block.get("id"))
        if block.get("type") not in ("table", "figure") or not loc or loc.get("src") == "manual":
            continue
        if stream and block["type"] == "figure" and block.get("caption_pos", "below") == "below":
            page = loc["page"]
            number = numbered_listings.figure_number(block.get("caption_en"))
            if number:
                if page not in listing_pages:
                    listing_pages[page] = numbered_listings.read_listings(root / "extract", page)
                listing = listing_pages[page].get(number)
                if listing:
                    bounds = numbered_listings.locate(listing, stream(page), loc["box"])
                    if bounds:
                        visual[block["id"]] = bounds
        if block["id"] in visual:
            loc.update(visual[block["id"]])
            loc.pop("boxes", None)
            loc["src"] = "graphic"
            continue
        if block.get("box"):
            layout[block["id"]] = {"page": block.get("page", loc["page"]), "box": block["box"], "src": "manual"}
            continue
        x0, y0, x1, y1 = loc["box"]
        others = [l for l in page_locs(layout, loc["page"]) if l["_parent"] is not loc]
        col = column(others, loc["box"])
        if col:
            x0, x1 = col
        elif x1 - x0 < 0.45 and abs((x0 + x1) / 2 - 0.5) > 0.1:  # 窄题注偏在一侧：正文绕排的小表/小图
            x0, x1 = max(0.05, x0 - 0.02), min(0.95, x1 + 0.02)
        else:
            x0, x1 = min(x0, 0.15), max(x1, 0.85)
        same_col = [l["box"] for l in others if overlap_x(l["box"], x0, x1)]
        if block.get("caption_pos", "below") == "below":
            above = [b[3] for b in same_col if b[3] < y0]
            y0 = max(above) + 0.005 if above else 0.08
        else:
            below = [b[1] for b in same_col if b[1] > y1]
            y1 = min(below) - 0.005 if below else 0.92
        loc["box"] = [x0, round(y0, 4), x1, round(y1, 4)]
        loc.pop("boxes", None)  # 图表框要包含图像本身，按题注扩展后用整个区域。
        loc["src"] = "caption"  # 撑过的框旁边常有绕排正文，后面截重叠时不能再截它
