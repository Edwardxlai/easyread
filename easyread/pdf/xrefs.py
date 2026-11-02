"""Where the PDF itself links inside the paper: references to figures, tables, sections, equations, cited works …
and footnote marks.

hyperref turns \\ref, \\autoref, \\eqref, \\cite and footnote marks into link annotations. extract() reads the words
each link covers (cached per source PDF, pdf-xrefs.json); insert() marks them in the page text given to the model:
a reference as [words](#), which the model completes from what the words refer to ([words](#tab:3),
[words](#cite:Jimenez-2024)), and a footnote mark as [^n]. These are hints only: the model writes the same links
where the PDF has none.
"""
from __future__ import annotations

import json
import re
from contextlib import closing
from pathlib import Path

from ..library.store import write_json_atomic
from . import textplace

_VERSION = 4
# Back-references and list items are not places a reader goes.
_SKIP = ("page.", "Doc-Start", "Item.", "lstnumber.")
# A numbered citation needs no hint: it is written [13] and linked by its number.
_NUMBERED = re.compile(r"[\d\s,;–\-]+")
_KEY = re.compile(r"^[A-Za-z0-9_.:@\-]{1,80}$")
SYMBOLS = {"∗": "*", "*": "*", "†": "†", "‡": "‡", "§": "§", "¶": "¶"}
_EDGE = re.compile(r"^[\s(\[{;,.:]+|[\s)\]};,.:]+$")
_LINK = re.compile(r"\[((?:\\.|[^\]\\\n])*)\]\(#[^)\s]*\)")
_MARK = re.compile(r"\[\^[^\]\s]{1,3}\]")


def is_footnote(key: str) -> bool:
    return key.startswith("Hfootnote")


def _chars(textpage) -> list[tuple[str, float, float, float]]:
    """(char, centre x, centre y, font size) in PDFium order; generated spaces and breaks have size 0."""
    from pypdfium2 import raw
    out = []
    for i in range(textpage.count_chars()):
        code = raw.FPDFText_GetUnicode(textpage, i)
        if not code or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
            continue
        left, bottom, right, top = textpage.get_charbox(i)
        out.append((chr(code), (left + right) / 2, (bottom + top) / 2, raw.FPDFText_GetFontSize(textpage, i)))
    return out


def extract(pdf: Path) -> list[list]:
    """[[page, key, words, footnote mark or "", text before, order]…] for every link to a place in the paper."""
    from pypdf import PdfReader
    from pypdf.generic import ArrayObject
    from .pdfwork import open_pdf

    reader = PdfReader(str(pdf))
    named = reader.named_destinations
    pages = {page.indirect_reference.idnum for page in reader.pages if page.indirect_reference}
    links = []
    with open_pdf(pdf) as doc:
        for n, page in enumerate(reader.pages):
            found = []
            for ref in page.get("/Annots") or []:
                a = ref.get_object()
                if a.get("/Subtype") != "/Link":
                    continue
                dest, action = a.get("/Dest"), a.get("/A")
                if action is not None:
                    action = action.get_object()
                    dest = action.get("/D") if action.get("/S") == "/GoTo" else None
                if dest is None:
                    continue
                if isinstance(dest, ArrayObject):  # explicit [page /XYZ left top zoom]
                    if not dest or getattr(dest[0], "idnum", None) not in pages:
                        continue
                    key = ""
                else:
                    key = str(dest)
                    if key.startswith(_SKIP) or not _KEY.match(key) or named.get(key) is None:
                        continue
                found.append((key, [float(v) for v in a["/Rect"]]))
            if not found:
                continue
            with closing(doc[n]) as pdf_page, closing(pdf_page.get_textpage()) as textpage:
                chars = _chars(textpage)
            stream = "".join(c for c, _, _, _ in chars)
            sizes = sorted(s for c, _, _, s in chars if s > 0 and not c.isspace())
            body = sizes[len(sizes) // 2] if sizes else 0
            spans = []  # [start, end, key] of each reference link's characters in the page stream
            for key, (x0, y0, x1, y1) in found:
                lo, hi, low, high = min(x0, x1) - 0.5, max(x0, x1) + 0.5, min(y0, y1) - 0.5, max(y0, y1) + 0.5
                inside = [i for i, (c, x, y, _) in enumerate(chars) if lo <= x <= hi and low <= y <= high and not c.isspace()]
                if not inside:
                    continue
                if not is_footnote(key):
                    spans.append([inside[0], inside[-1] + 1, key])
                    continue
                # The mark is the raised small glyph; the rectangle often also covers the word it follows.
                small = [i for i in inside if body and 0 < chars[i][3] < body * 0.85]
                raw = "".join(chars[i][0] for i in small)
                mark = "".join(SYMBOLS.get(c, c) for c in raw if c.isdigit() or c in SYMBOLS)
                if small and mark and len(mark) <= 3:
                    links.append([n + 1, key, raw, mark, stream[max(0, small[0] - textplace.CONTEXT):small[0]], small[0]])
            for start, end, key in _joined(stream, spans):
                text = " ".join(stream[start:end].split())
                words = _EDGE.sub("", text)
                if words.count("(") > words.count(")") and text.endswith(")"):
                    words += ")"  # Jimenez et al. (2024): the closing bracket belongs to the citation
                if not words or len(words) > 80 or (key.startswith("cite.") and _NUMBERED.fullmatch(words)):
                    continue
                start += len(stream[start:end]) - len(stream[start:end].lstrip(" ([{;,.:"))
                links.append([n + 1, key, words, "", stream[max(0, start - textplace.CONTEXT):start], start])
    return links


_GAP = re.compile(r"[\s,.(]{0,4}")


def _joined(stream: str, spans: list[list]) -> list[list]:
    """natbib links an author-year citation twice, the names and the year: "[Jimenez et al.], [2024]". Adjacent
    links to the same place become one span, so the model sees and links the whole citation."""
    out: list[list] = []
    for start, end, key in sorted(spans):
        if out and key and out[-1][2] == key and _GAP.fullmatch(stream[out[-1][1]:start]):
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end, key])
    for span in out:
        if stream[span[0]:span[1]].count("(") > stream[span[0]:span[1]].count(")") and stream[span[1]:span[1] + 1] == ")":
            span[1] += 1
    return out


def ensure(ws) -> dict[str, list[list]]:
    """Links per page ("3": [...]), in text order; read from the PDF once per source file."""
    source = ws.source_pdf
    if not source or not source.is_file():
        return {}
    stat = source.stat()
    identity = [str(source.resolve()), stat.st_size, stat.st_mtime_ns, _VERSION]
    cache = ws.root / "extract" / "pdf-xrefs.json"
    try:
        saved = json.loads(cache.read_text(encoding="utf-8"))
        records = saved["links"] if saved.get("source") == identity else None
    except (OSError, ValueError, KeyError):
        records = None
    if records is None:
        try:
            records = extract(source)
        except Exception:  # Internal links are a reading aid; an odd PDF must not block translating it.
            from ..app.log import log
            log.exception("Could not read PDF internal links: %s", source.name)
            return {}
        cache.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(cache, {"source": identity, "links": records})
    pages: dict[str, list[list]] = {}
    for record in records:
        pages.setdefault(str(record[0]), []).append(record)
    for found in pages.values():
        found.sort(key=lambda r: r[5])
    return pages


def insert(text: str, records: list[list]) -> str:
    """[words](#) around each reference for the model to complete, [^n] in place of each footnote mark."""
    if not records:
        return text
    items = []
    for _, _, words, mark, before, _ in records:
        if mark:
            items.append(textplace.Item(words, before, lambda s, m=mark: f"[^{m}]", glued=True))
        else:
            label = lambda s: "[" + s.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]") + "](#)"
            items.append(textplace.Item(words, before, label))
    return textplace.place(text, items)


def unlink(text: str) -> str:
    """[表 3](#tab:3) -> 表 3: the words of each internal link, for text read away from the paper (exports)."""
    return _LINK.sub(lambda m: re.sub(r"\\(.)", r"\1", m.group(1)), text) if isinstance(text, str) else text


def plain(text: str) -> str:
    """Internal links and footnote marks out of text shown without Markdown (title, authors, reference entries)."""
    return _MARK.sub("", unlink(text)) if isinstance(text, str) else text
