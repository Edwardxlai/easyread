"""Derive citation links from the library's existing metadata and reference lists.

No graph is persisted: edits, imports and deletions are reflected on the next request.
An ambiguous identifier or title is deliberately left unresolved.
"""
from __future__ import annotations

import re
import hashlib
import unicodedata
from collections import defaultdict
from urllib.parse import quote

from .store import DataReadError

_DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"<>\[\]()]+", re.I)
_ARXIV = re.compile(r"(?:arxiv\s*:\s*|arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5}(?:v\d+)?)", re.I)


def _doi(text):
    return {m.group().rstrip(".,;:").lower() for m in _DOI.finditer(str(text or ""))}


def _arxiv(text):
    return {re.sub(r"v\d+$", "", m.group(1).lower()) for m in _ARXIV.finditer(str(text or ""))}


def _words(text):
    text = unicodedata.normalize("NFKC", str(text or "")).casefold()
    return " ".join(re.findall(r"[^\W_]+", text, re.UNICODE))


def graph_for(lib, pid):
    papers = {}
    incomplete = False
    for ws in lib.all():
        try:
            paper = ws.load("paper") or {}
            item = ws.load("item") or {}
        except (DataReadError, OSError):
            if ws.id == pid:
                raise
            incomplete = True
            continue
        meta = dict(paper.get("meta") or {})
        meta.update({k: v for k, v in (item.get("meta_override") or {}).items() if v or k == "doi"})
        papers[ws.id] = {"id": ws.id, "title": meta.get("title_zh") or meta.get("title_en") or ws.id,
                         "title_en": meta.get("title_en") or "", "doi": meta.get("doi") or "",
                         "arxiv": meta.get("arxiv") or "", "references": paper.get("references") or [],
                         "citation_links": item.get("citation_links") or {}}
    if pid not in papers:
        raise KeyError(pid)
    doi_index, arxiv_index = defaultdict(set), defaultdict(set)
    titles = {}
    for p in papers.values():
        for d in _doi(p["doi"]): doi_index[d].add(p["id"])
        for a in _arxiv(p["arxiv"]): arxiv_index[a].add(p["id"])
        title = _words(p["title_en"])
        if len(title) >= 16 and len(title.split()) >= 3:
            titles[p["id"]] = " " + title + " "

    def resolve(ref, source):
        text = str(ref.get("text") or "")
        ids = set()
        for d in _doi(text): ids.update(doi_index[d])
        for a in _arxiv(text): ids.update(arxiv_index[a])
        ids.discard(source)
        # Never guess if an identifier matches multiple library entries.
        if len(ids) == 1:
            return next(iter(ids))
        if ids:
            return None
        normalized = " " + _words(text) + " "
        ref_dois, ref_arxivs = _doi(text), _arxiv(text)
        ids = set()
        for ident, title in titles.items():
            if ident == source or title not in normalized:
                continue
            other_dois, other_arxivs = _doi(papers[ident]["doi"]), _arxiv(papers[ident]["arxiv"])
            if (ref_dois and other_dois and ref_dois.isdisjoint(other_dois)) or (
                    ref_arxivs and other_arxivs and ref_arxivs.isdisjoint(other_arxivs)):
                continue
            ids.add(ident)
        return next(iter(ids)) if len(ids) == 1 else None

    outward = {}
    inward = defaultdict(list)
    for source, paper in papers.items():
        refs = []
        for ref in paper["references"]:
            if not isinstance(ref, dict): continue
            manual = paper["citation_links"].get(str(ref.get("id", ""))) or {}
            target = manual.get("target") if manual.get("text") == str(ref.get("text") or "") else None
            if target not in papers or target == source:
                target = resolve(ref, source)
            row = {"id": str(ref.get("id", "")), "text": str(ref.get("text") or ""), "target": target}
            dois, arxivs = _doi(row["text"]), _arxiv(row["text"])
            row["fingerprint"] = hashlib.sha256(row["text"].encode("utf-8")).hexdigest()
            if len(dois) == 1:
                row["source_url"] = "https://doi.org/" + quote(next(iter(dois)), safe="/")
            elif len(arxivs) == 1:
                row["source_url"] = "https://arxiv.org/abs/" + quote(next(iter(arxivs)), safe="")
            if target:
                row["title"] = papers[target]["title"]
                inward[target].append({"id": source, "title": paper["title"], "ref_id": row["id"]})
            refs.append(row)
        outward[source] = refs
    return {"paper": {"id": pid, "title": papers[pid]["title"]}, "references": outward[pid],
            "cited_by": inward[pid], "incomplete": incomplete}


def link_reference(lib, ws, ref_id, expected_hash, target):
    """Record the reader's choice, tied to the specific bibliography text."""
    from ..app.i18n import tr
    if target == ws.id or not lib.ws(target):
        raise ValueError(tr("目标论文不在文献库中"))

    # Translation can replace the reference list while a download is in flight.
    # The item and paper share the workspace write lock used by paper updates.
    def apply(item):
        refs = (ws.load("paper") or {}).get("references") or []
        matches = [r for r in refs if isinstance(r, dict) and str(r.get("id", "")) == ref_id]
        text = str(matches[0].get("text") or "") if len(matches) == 1 else ""
        if len(matches) != 1 or hashlib.sha256(text.encode("utf-8")).hexdigest() != expected_hash:
            raise ValueError(tr("参考文献已变化，请重新选择条目"))
        item.setdefault("citation_links", {})[ref_id] = {"text": text, "target": target}
    ws.update("item", apply)
    return {"ok": True, "target": target}
