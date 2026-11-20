"""Incremental, in-memory full-text index of passages in the active library."""
import math
import re
import threading
from collections import Counter
from dataclasses import dataclass

from ..translate.prompts import _block_text
from .store import DataReadError, file_version

_WORDS = re.compile(r"[\u3400-\u9fff]+|[^\W_]+", re.UNICODE)
_STOP = set("a an and are as at be by do for from how in is it of on or that the this to what which with".split())


def terms(text):
    for word in _WORDS.findall(text.casefold()):
        if "\u3400" <= word[0] <= "\u9fff":
            yield from (word[i:i + 2] for i in range(max(1, len(word) - 1)))
        elif word not in _STOP:
            yield word


@dataclass
class Passage:
    paper: str
    title: str
    anchor: str
    text: str
    words: Counter

    def source(self):
        return dict(paper=self.paper, title=self.title, anchor=self.anchor, text=self.text)


def passages(ws):
    paper = ws.load("paper") or {}
    meta = paper.get("meta") or {}
    title = meta.get("display_title") or meta.get("title_zh") or meta.get("title_en") or ws.id
    edits = (ws.load("reader") or {}).get("edits") or {}
    for block in paper.get("blocks") or []:
        anchor = block.get("id")
        if not anchor or block.get("type") in {"heading", "reference"}:
            continue
        source = block.get("en") or block.get("caption_en") or ""
        if block.get("type") == "list":
            source = "\n".join(it.get("en", "") for it in block.get("items", []))
        translated = edits.get(anchor, {}).get("zh", _block_text(block))
        for text in dict.fromkeys([source, translated]):
            for start in range(0, len(text or ""), 900):
                excerpt = text[start:start + 900].strip()
                if excerpt:
                    yield Passage(ws.id, title, anchor, excerpt, Counter(terms(excerpt)))


class PassageIndex:
    def __init__(self):
        self._papers = {}
        self._lock = threading.Lock()

    def snapshot(self, library, allowed=None):
        with self._lock:
            workspaces = library.all()
            ids = {ws.id for ws in workspaces}
            self._papers = {key: value for key, value in self._papers.items() if key in ids}
            live = {}
            for ws in workspaces:
                if allowed is not None and ws.id not in allowed:
                    continue
                version = (file_version(ws.paper_path), file_version(ws.reader_path))
                old = self._papers.get(ws.id)
                if old and old[0] == version:
                    live[ws.id] = old
                    continue
                try:
                    live[ws.id] = (version, list(passages(ws)))
                except (DataReadError, FileNotFoundError):
                    continue
            self._papers.update(live)
            return ([row for _, rows in live.values() for row in rows],
                    sum(not rows for _, rows in live.values()))


def rank(rows, query, limit=8):
    keys = set(terms(query))
    freq = Counter(key for row in rows for key in keys.intersection(row.words))
    weights = {key: math.log1p((len(rows) - count + .5) / (count + .5)) for key, count in freq.items()}
    scored = []
    for row in rows:
        score = sum(weights[key] * row.words[key] / (1 + row.words[key])
                    for key in keys.intersection(row.words))
        if score:
            scored.append((score, row))
    best = sorted(scored, key=lambda pair: -pair[0])
    # Give distinct papers a place, then fill the remaining budget with supporting passages.
    chosen, papers, anchors = [], set(), set()
    for distinct in (True, False):
        for _, row in best:
            anchor = (row.paper, row.anchor)
            if anchor in anchors or (distinct and row.paper in papers):
                continue
            chosen.append(row.source())
            anchors.add(anchor)
            papers.add(row.paper)
            if len(chosen) == limit:
                return chosen
    return chosen
