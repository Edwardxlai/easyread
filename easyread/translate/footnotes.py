"""Keep source-backed footnote markers when checking a translation or a repair."""
from collections import Counter, defaultdict
import re

from .codeblocks import prose

_MARK = re.compile(r"(?<!\\)\[\^(\d{1,3})\]")
# PDFium flattens raised digits: "... conjoint study, respectively.3 Then ...".
_CALL = re.compile(r"((?:[A-Za-z][\w'-]*[, \t\r\n]+){1,3}[A-Za-z][\w'-]*[.!?])(\d{1,3})(?=\s|$)")


def markers(text):
    return Counter(_MARK.findall(prose(text))) if isinstance(text, str) else Counter()


def fields(blocks):
    for b in blocks:
        key = b["id"]
        if b.get("role") == "footnote":
            continue
        if b["type"] in ("para", "heading"):
            yield key, b, b.get("en", ""), b.get("zh", "")
        elif b["type"] == "list":
            for i, item in enumerate(b.get("items") or []):
                if isinstance(item, dict):
                    yield f"{key}#{i}", b, item.get("en", ""), item.get("zh", "")
        elif b["type"] in ("figure", "table"):
            for field in ("caption", "image"):
                yield f"{key}#{field}", b, b.get(field + "_en", ""), b.get(field + "_zh", "")


def expected(ws, blocks):
    """Bind an extracted callout only to a unique paragraph and a matching note on its page."""
    values = list(fields(blocks))
    needed = {key: markers(en) | markers(zh) for key, _, en, zh in values}
    notes = defaultdict(Counter)
    for b in blocks:
        if b.get("role") == "footnote" and b.get("type") == "para":
            notes[b["page"]][str(b.get("num"))] += 1
    hints = {}
    for page, nums in notes.items():
        path = ws.root / "extract" / f"page-{page:03d}.txt"
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        candidates = [(key, " ".join(prose(en).split())) for key, b, en, _ in values
                      if b.get("page") == page and isinstance(en, str)]
        for context, num in _CALL.findall(source):
            if nums[num] != 1:
                continue
            # A PDF line can start halfway through the sentence retained in a paragraph.
            tail = " ".join(context.split()[-2:])
            matches = [key for key, en in candidates if tail in en]
            if len(matches) == 1:
                key = matches[0]
                needed[key][num] = max(1, needed[key][num])
                hints[key, num] = tail
    return needed, hints


def missing(key, text, required, hints=None):
    absent = required - markers(text)
    return [f"{key}：请在对应原文位置保留脚注标记 [^{n}]"
            + (f"（原页位置：{hints[key, n]}）" if hints and (key, n) in hints else "")
            for n in absent]


def problems(blocks, expected_notes, read):
    needed, hints = expected_notes
    out = []
    for key, _, en, zh in fields(blocks):
        if needed.get(key):
            out.extend(missing(key, en, needed[key], hints))
            if not read:
                out.extend(missing(key, zh, needed[key], hints))
    return out
