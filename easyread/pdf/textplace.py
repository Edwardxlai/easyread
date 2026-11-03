"""Place markup into extracted page text at the occurrence the PDF points at.

PDF facts (a bold run, a link) are known by their words and the text just before them in PDFium
character order. The page .txt has the same order but its own spacing, and the same words often
occur several times on a page, so each item is matched by its words plus the longest agreeing
stretch of preceding text, scanning forward. Items that cannot be told apart stay plain.
"""
from __future__ import annotations

import re
from typing import Callable, Iterable, NamedTuple

CONTEXT = 24  # characters of preceding text recorded with each item


class Item(NamedTuple):
    needle: str                      # the words as they appear in the PDF
    before: str                      # PDF text just before them
    render: Callable[[str], str]     # matched text -> replacement
    glued: bool = False              # may touch letters (a footnote mark right after a word)
    guard: str = ""                  # characters that must not touch the match


def squash(text: str) -> str:
    return re.sub(r"\s+|\*", "", text)


def place(text: str, items: Iterable[Item]) -> str:
    if not isinstance(text, str) or not text:
        return text
    out, cursor = [], 0
    for item in items:
        words = item.needle.split()
        if not words:
            continue
        pattern = re.compile(r"\s*".join(re.escape(w) for w in words) if item.glued else r"\s+".join(re.escape(w) for w in words))
        want, choices = squash(item.before), []
        for match in pattern.finditer(text, cursor):
            a, b = match.span()
            if not item.glued and ((a and text[a - 1].isalnum() and text[a].isalnum()) or
                                   (b < len(text) and text[b - 1].isalnum() and text[b].isalnum())):
                continue  # whole words only: never "here" inside "there"
            if item.guard and ((a and text[a - 1] in item.guard) or (b < len(text) and text[b] in item.guard)):
                continue
            have = squash(text[max(0, a - 3 * CONTEXT):a])
            score = next((n for n in range(min(len(have), len(want)), 0, -1) if have[-n:] == want[-n:]), 0)
            choices.append((score, -a, a, b))
        if not choices:
            continue
        choices.sort(reverse=True)
        score, _, a, b = choices[0]
        if score < min(8, len(want)) or (len(choices) > 1 and choices[1][0] == score):
            continue
        out.append(text[cursor:a] + item.render(text[a:b]))
        cursor = b
    return "".join(out) + text[cursor:]
