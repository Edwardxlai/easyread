"""Find line-numbered code immediately followed by a figure caption in extracted PDF text."""
from __future__ import annotations

import re


_LINE = re.compile(r"^\s*(\d{1,3})[ \t]+\S")
_CAPTION = re.compile(r"^\s*(?:Figure|Fig\.)\s+(\d+(?:\.\d+)*)[.:]\s+\S", re.I)
_CODE = re.compile(r"[{}]|:=|=>|\w+\([^)]*\)\s*;")


def figure_number(caption):
    match = _CAPTION.match(caption) if isinstance(caption, str) else None
    return match[1] if match else None


def read_listings(extract, page):
    try:
        lines = (extract / f"page-{page:03d}.txt").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return {}
    listings = {}
    body = []
    last = 0
    for line in lines:
        if not line.strip():
            continue
        number = figure_number(line)
        if number:
            # Exclude numbered paragraphs and references; require programming punctuation.
            if (last >= 3 and (_LINE.match(body[-1]) or _CODE.search(body[-1]))
                    and sum(bool(_CODE.search(row)) for row in body) >= 2):
                listings[number] = ("\n".join(body), line.strip())
            body, last = [], 0
            continue
        match = _LINE.match(line)
        if match:
            index = int(match[1])
            if index == 1:
                body, last = [line], 1
            elif body and index == last + 1:
                body.append(line)
                last = index
            else:
                body, last = [], 0
        elif body:
            body.append(line)
            if len(body) > last * 6:
                body, last = [], 0
    return listings


def locate(listing, stream, caption):
    """Require the exact listing immediately before its caption in the PDF character stream."""
    from .pdfwork import _bounds, _norm

    if not stream:
        return None
    text, indices, chars = stream
    body, title = listing
    code = _norm(body)
    needle = code + _norm(title)
    start = text.find(needle)
    if not code or start < 0 or text.find(needle, start + 1) >= 0:
        return None
    glyphs = [c[1:5] for c in chars[indices[start]:indices[start + len(code)]]
              if c[0].strip() and c[3] > c[1] and c[4] > c[2]]
    if not glyphs:
        return None
    x0, y0, x1, y1 = _bounds(glyphs)
    if not 0 <= caption[1] - y1 <= .04 or min(x1, caption[2]) <= max(x0, caption[0]):
        return None
    crop = [max(0, x0 - .005), max(0, y0 - .005), min(1, x1 + .005), min(caption[1], y1 + .005)]
    return {"box": _bounds([crop, caption]), "crop": crop}
