"""Bold and italic runs from the PDF text layer, marked as **…** / *…* in the text given to the translator.

The page .txt files stay plain: locating, continuation and page checks compare against them.
Runs are read from PDFium per character (font weight, italic flag, font name), cached per paper
like pdf-links.json, and inserted only when a prompt is built, so older imports get them too.
"""
from __future__ import annotations

import ctypes
import json
import re
from contextlib import closing
from pathlib import Path

from ..library.store import write_json_atomic
from . import textplace

_VERSION = 1
_ITALIC_FLAG = 0x40  # PDF font descriptor flag 7
# Math fonts set the italic flag on every variable; marking them would wrap formulas in *…*.
_MATH_FONT = re.compile(r"CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|Math|Symbol|rsfs|EUFM|EURM|EUSM|wasy|stmary|esint|"
                        r"TXMI|TXSY|TXEX|PXMI|PXSY|PXEX|NTXMI|NTXSY", re.I)
# NimbusRomNo9L-Medi is LaTeX Times bold; CMBX is Computer Modern bold.
_BOLD_FONT = re.compile(r"bold|black|heavy|demi|CMBX|CMB\d|Medi(?!um)", re.I)
_ITALIC_FONT = re.compile(r"ital|oblique|CMTI|CMSL", re.I)
_WORD = re.compile(r"[^\W\d_]{2,}")
_LEAD = re.compile(r"^[^\w(\[]+")  # a run starts at a word or an opening bracket
_MARK = {"b": "**", "i": "*"}


def _style(name: str, weight: int, flags: int) -> str | None:
    """'b' bold, 'i' italic, '' regular; None for generated characters that carry no font."""
    if not name:
        return None
    name = name.split("+", 1)[-1]
    if _MATH_FONT.search(name):
        return ""
    if weight >= 600 or _BOLD_FONT.search(name):
        return "b"  # bold italic is marked bold: one pair of markers is enough for the reader
    if flags & _ITALIC_FLAG or _ITALIC_FONT.search(name):
        return "i"
    return ""


def _runs(textpage) -> list[list[str]]:
    """[[style, text, text just before it], …] in PDFium character order (the order of get_text_bounded).

    Spaces, line breaks, regular-weight punctuation (∗ † , in author lists) and super/subscripts do not
    break a run; a run continues over a line break unless the line before it was styled end to end."""
    from pypdfium2 import raw

    buf, flags = ctypes.create_string_buffer(256), ctypes.c_int()
    chars = []  # (char, style or None, font size)
    for index in range(textpage.count_chars()):
        code = raw.FPDFText_GetUnicode(textpage, index)
        if not code or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
            continue  # unmapped glyphs and surrogate halves
        char = chr(code)
        if char in "\r\n":
            chars.append((char, None, 0.0))
            continue
        size = raw.FPDFText_GetFontInfo(textpage, index, buf, len(buf), ctypes.byref(flags))
        name = buf.value.decode("utf-8", "replace") if size else ""
        chars.append((char, _style(name, raw.FPDFText_GetFontWeight(textpage, index), flags.value),
                      raw.FPDFText_GetFontSize(textpage, index)))
    stream = "".join(c for c, _, _ in chars)

    def line_bounds(a: int, b: int) -> tuple[int, int]:
        start = max(stream.rfind("\n", 0, a), stream.rfind("\r", 0, a)) + 1
        ends = [p for p in (stream.find("\r", b), stream.find("\n", b)) if p >= 0]
        return start, min(ends) if ends else len(stream)

    letters = lambda s: any(c.isalpha() for c in s)  # noqa: E731
    spans, run = [], None  # run: [style, start, end, size]
    for i, (char, style, size) in enumerate(chars):
        if char in "\r\n" and run and run[0] and not letters(stream[line_bounds(run[1], run[1])[0]:run[1]]):
            spans.append(run)  # the line was styled from its start: a heading, never joined to the next line
            run = None
            continue
        if style is None or (style == "" and not char.isalnum()) or (run and size < run[3] * 0.8):
            continue
        if run and run[0] == style:
            run[2] = i + 1
            continue
        if run and run[0]:
            spans.append(run)
        run = [style, i, i + 1, size]
    if run and run[0]:
        spans.append(run)

    runs = []
    for style, a, b, _ in spans:
        text = stream[a:b]
        a += len(text) - len(_LEAD.sub("", text))
        b -= len(text) - len(text.rstrip(" \t,;"))  # and does not end on a separator
        text = stream[a:b]
        start, end = line_bounds(a, b)
        # Whole lines in one style (headings, author lists, table header rows): the block type carries that.
        if not letters(stream[start:a]) and not letters(stream[b:end]):
            continue
        if _WORD.search(text):
            runs.append([style, text, stream[max(0, a - textplace.CONTEXT):a]])
    return runs


def extract(pdf: Path) -> dict[str, list[list[str]]]:
    from .pdfwork import open_pdf

    pages = {}
    with open_pdf(pdf) as doc:
        for i in range(len(doc)):
            with closing(doc[i]) as page, closing(page.get_textpage()) as textpage:
                runs = _runs(textpage)
                if runs:
                    pages[str(i + 1)] = runs
    return pages


def ensure(ws) -> dict[str, list[list[str]]]:
    source = ws.source_pdf
    if not source or not source.is_file():
        return {}
    stat = source.stat()
    identity = [str(source.resolve()), stat.st_size, stat.st_mtime_ns, _VERSION]
    cache = ws.root / "extract" / "pdf-emphasis.json"
    try:
        saved = json.loads(cache.read_text(encoding="utf-8"))
        if saved.get("source") == identity:
            return saved.get("pages", {})
    except (OSError, ValueError):
        pass
    try:
        pages = extract(source)
    except Exception:  # Font details are a hint for the translator; never block a translation on them.
        from ..app.log import log
        log.exception("Could not read PDF emphasis: %s", source.name)
        return {}
    cache.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(cache, {"source": identity, "pages": pages})
    return pages


def insert(text: str, runs: list[list[str]]) -> str:
    """Wrap each run at the occurrence whose preceding text matches the PDF, scanning forward in page order.
    A run that cannot be told apart from another occurrence is left plain."""
    if not runs:
        return text
    # Never against a literal asterisk: it would merge with the markers.
    return textplace.place(text, (textplace.Item(run, before, lambda s, m=_MARK[style]: m + s + m, guard="*")
                                  for style, run, before in runs))
