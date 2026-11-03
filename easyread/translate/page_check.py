"""一批几页里模型漏掉了某一页：别的页有内容，这一页一个块都没有，原文却有正文（#55）。

以前整批只要有块就整批记“已译”，漏掉的那页在文献库里也算译完，用户看不出来。
现在逐页核对：原页正文在这批任何块的英文里都找不到，才算漏了。
跨页续文（上一页那段接着写到这页）、模型把页码标错的块，原文都能在别的块里找到，不算漏。
旧版本已经误记成“已译”的页，repair_done 在文献库列表里每篇查一次，把它们改回没译。
"""
from __future__ import annotations

import json
import re

from ..library.store import Workspace

MIN_LETTERS = 80   # 原页字母少于这个数（空白页、只有页码或一张图）不核对
PROBE = 30         # 每个探针取多少个字母


def _letters(text: str) -> str:
    return re.sub(r"[^a-z]", "", text.lower())


def _source(ws: Workspace, n: int) -> str:
    try:
        return (ws.root / "extract" / f"page-{n:03d}.txt").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _found(page: str, have: str) -> bool:
    """原页正文取前、中、后三段字母，有一段出现在块里就算这页译到了（公式、断词可能让个别探针对不上）。"""
    spots = [len(page) // 4, len(page) // 2, len(page) * 3 // 4]
    return any(page[i:i + PROBE] in have for i in spots)


_REF_HEADING = re.compile(r"^\s*(?:references|bibliography)\s*$", re.I | re.M)


def _bibliography(ws: Workspace, n: int) -> bool:
    """这页有参考文献条目（References 标题之后、或整页都是）：只有一个落在页底的标题不算。"""
    src = _source(ws, n)
    head = _REF_HEADING.search(src)
    return len(_letters(src[head.end():] if head else src)) >= MIN_LETTERS


def missing_pages(ws: Workspace, batch: list[int], data: dict) -> list[int]:
    """这批里漏译的页。整批为空另有处理（continuation），这里只管“有的页有、有的页没有”，
    以及给了参考文献标题块、却一条条目都没给的参考文献页（条目丢了，正文链不过去）。"""
    blocks = data.get("blocks") or []
    refs = [b.get("page") or batch[0] for b in blocks if b.get("type") == "references"]
    if refs and not data.get("references"):
        lost = [n for n in batch if n >= min(refs) and _bibliography(ws, n)]
        if lost:
            return lost
    if len(batch) < 2 or not blocks:
        return []
    if data.get("references") and not refs:
        return []  # 参考文献续页只给 references，没有块，也没法逐页对
    have = _letters(json.dumps(blocks, ensure_ascii=False))
    out = []
    for n in batch:
        if any(b.get("page") == n for b in blocks) or (refs and n >= min(refs)):
            continue
        page = _letters(_source(ws, n))
        if len(page) >= MIN_LETTERS and not _found(page, have):
            out.append(n)
    return out


def stale_done(ws: Workspace, paper: dict) -> list[int]:
    """记成已译、却一个块都没有、原文又有正文且在全文哪个块里都找不到的页（旧版本按批记完成留下的）。"""
    blocks = paper.get("blocks") or []
    on = {b.get("page") for b in blocks}
    refs = [b.get("page") or 0 for b in blocks if b.get("type") == "references"]
    have, out = None, []
    for n in sorted((paper.get("translation") or {}).get("done_pages", [])):
        if n in on or (refs and n >= min(refs)):
            continue
        page = _letters(_source(ws, n))
        if len(page) < MIN_LETTERS:
            continue
        if have is None:
            have = _letters(json.dumps(blocks, ensure_ascii=False))
        if not _found(page, have):
            out.append(n)
    return out


def repair_done(ws: Workspace) -> list[int]:
    """每篇只查一次（记 translation.gaps_checked）；新的翻译已经逐页核对，不会再留下这种页。返回改回没译的页。"""
    def apply(paper):
        tr = paper.setdefault("translation", {})
        if tr.get("gaps_checked"):
            return []
        bad = stale_done(ws, paper)
        if bad:
            tr["done_pages"] = [n for n in tr.get("done_pages", []) if n not in bad]
        tr["gaps_checked"] = 1
        return bad
    return ws.update("paper", apply)


class MissingPages(Exception):
    """这批其余的页已经并进去了，只有 pages 这几页漏了，单独再译一次。"""

    def __init__(self, pages: list[int]):
        super().__init__(pages)
        self.pages = pages
