"""Locate prose as matched glyph regions, preserving column and page breaks."""
from __future__ import annotations

import re
import unicodedata
from difflib import Match, SequenceMatcher
from functools import lru_cache
from statistics import median


def _norm(text):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKC", text).lower())


def _bounds(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _matching_runs(target, text):
    start = text.find(target)
    if start >= 0:
        return (Match(0, start, len(target)),)
    return tuple(m for m in SequenceMatcher(None, target, text, autojunk=False).get_matching_blocks()
                 if m.size >= 24)


# A later translation batch locates earlier paragraphs again. Reuse offsets
# only when both normalized strings still agree. Always read current geometry.
_cached_runs = lru_cache(maxsize=512)(_matching_runs)


def _regions(chars, positions):
    """Join neighboring glyphs into lines, then vertically adjacent line runs.

    A column gutter or a figure-sized vertical gap must remain outside the box.
    Matching offsets, rather than a page-wide y sort, preserve reading order.
    """
    glyphs = [(chars[i][1:5], pos) for i, pos in positions.items()
              if chars[i][3] > chars[i][1] and chars[i][4] > chars[i][2]]
    if not glyphs:
        return []
    height = median(b[3] - b[1] for b, _ in glyphs)
    rows = []
    for box, pos in sorted(glyphs, key=lambda g: ((g[0][1] + g[0][3]) / 2, g[0][0])):
        center = (box[1] + box[3]) / 2
        row = next((r for r in reversed(rows[-3:]) if abs(r[0] - center) < height * .6), None)
        if row is None:
            row = [center, []]
            rows.append(row)
        row[1].append((box, pos))
    lines = []
    for _, glyphs in rows:
        fragments = []
        for box, pos in sorted(glyphs, key=lambda g: g[0][0]):
            if not fragments or box[0] - fragments[-1][0][2] > .018:
                fragments.append([list(box), pos])
            else:
                fragments[-1][0] = _bounds([fragments[-1][0], box])
                fragments[-1][1] = min(fragments[-1][1], pos)
        lines.extend(fragments)
    runs = []
    for box, pos in sorted(lines, key=lambda g: g[0][1]):
        candidates = [r for r in runs if box[1] <= r[0][3] + height * 1.4
                      and box[3] >= r[0][1] - .002
                      and min(box[2], r[0][2]) - max(box[0], r[0][0])
                      > min(box[2] - box[0], r[0][2] - r[0][0]) * .45]
        if candidates:
            run = max(candidates, key=lambda r: r[0][3])
            run[0] = _bounds([run[0], box])
            run[1] = min(run[1], pos)
        else:
            runs.append([list(box), pos])
    runs = [r for r in runs if r[0][2] - r[0][0] >= .012]
    return [box for box, _ in sorted(runs, key=lambda r: r[1])]


def locate_prose(english, page, stream):
    """Match actual text on successive pages; never estimate a missing tail.

    The primary page/box remains readable by older consumers. `regions` is the
    complete, ordered location, and can include multiple boxes on several pages.
    """
    target = _norm(re.sub(r"\$[^$]*\$", " ", english))
    if len(target) < 24:
        return None
    regions, covered, progress = [], set(), 0
    for pn in range(page, page + 8):
        data = stream(pn)
        if not data:
            break
        text, idx, chars = data
        # Avoid retaining unusually large page streams in the process cache.
        runs = _cached_runs if len(target) + len(text) <= 24_000 else _matching_runs
        matches = [m for m in runs(target, text) if m.a + m.size > progress]
        if not matches or (sum(m.size for m in matches) < 48 and
                           not any(m.a == 0 or m.a + m.size >= len(target) - 4 for m in matches)):
            if pn == page:
                continue  # The model can assign the preceding page number.
            break
        positions = {}
        for match in matches:
            start = max(match.a, progress)
            for pos in range(start, match.a + match.size):
                char = idx[match.b + pos - match.a]
                positions[char] = min(positions.get(char, pos), pos)
                covered.add(pos)
        boxes = _regions(chars, positions)
        regions.extend({"page": pn, "box": box} for box in boxes)
        progress = max(m.a + m.size for m in matches)
        if progress >= len(target) - 4:
            break
    if not regions or len(covered) < len(target) * .65:
        return None
    first_page = regions[0]["page"]
    boxes = [r["box"] for r in regions if r["page"] == first_page]
    loc = {"page": first_page, "box": _bounds(boxes), "src": "text", "regions": regions}
    if len(boxes) > 1:
        loc["boxes"] = boxes
    return loc
