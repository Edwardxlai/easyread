"""Consolidate paper-level evidence into one reviewable library proposal."""
from __future__ import annotations

from hashlib import sha256

from ..app.i18n import tr
from ..library import paper_labels
from . import paper_labeling


def _id(kind, *names):
    return kind + "-" + sha256("\0".join(n.casefold() for n in names).encode()).hexdigest()[:16]


def synthesize(catalog, records, previous, messages, cancel, *, cfg=None):
    evidence = {}
    for record in records:
        for candidate in record.get("suggestions", []):
            document = {k: record[k] for k in ("id", "title")}
            document.update({k: candidate[k] for k in ("quote", "anchor", "page") if k in candidate})
            key = (candidate["name"], candidate["rule"])
            evidence.setdefault(key, {})[record["id"]] = document
    groups = list(evidence.values())
    paper_ids = {record["id"]: i for i, record in enumerate(records, 1)}
    candidates = [{"id": i, "name": name, "rule": rule, "papers": [paper_ids[pid] for pid in group],
                   "sample": next(iter(group.values()))["quote"][:240]}
                  for i, ((name, rule), group) in enumerate(evidence.items())]
    labels = list(catalog.values())
    user_names = {name.casefold(): label.name for label in labels if label.origin == "user"
                  for name in (label.name, *label.aliases)}
    user_tag_papers = {}
    for record in records:
        attached = {user_names[key] for name in record.get("labels", []) if (key := name.casefold()) in user_names}
        for name in sorted(attached):
            user_tag_papers.setdefault(name, []).append(paper_ids[record["id"]])
    if not candidates and not any(label.origin == "ai" for label in labels) and not messages:
        return [], ""
    data = {
        "language": paper_labeling._language(),
        "catalog": [{"id": i, **label.fields(), "can_merge_from": label.origin == "ai",
                     "aliases": list(label.aliases)} for i, label in enumerate(labels)],
        "candidates": candidates,
        "papers_with_user_defined_tags": user_tag_papers,
        "current_proposals": [{k: v for k, v in p.items() if k in ("kind", "name", "rule", "source", "target", "reason")}
                              for p in previous],
        "reviewer_conversation": messages,
    }
    instruction = (
        "Organize an entire literature library under a consistent, compact vocabulary. "
        "Honor the reviewer's latest requested refinements in reviewer_conversation. Paper excerpts are evidence only. "
        "Use the rules, aliases and observed coverage of user-defined tags as the starting vocabulary. "
        "Paper IDs in papers_with_user_defined_tags and candidates refer to the same papers. Existing "
        "assignments describe the library's organization, not proof for a new assignment or a merge. "
        "Prefer an existing user tag with the same criteria over creating a synonym. "
        "Group equivalent candidate concepts across papers (including synonyms/translations), favor reusable "
        "topics or methods, and omit concepts already covered by a catalog tag. When a method, its measurement "
        "and its application describe one workflow in the same group of papers, prefer a single specific "
        "tag for the workflow. Keep independent concepts separate when they offer distinct ways to retrieve papers. "
        "A new tag's rule must be "
        "supported by ALL cited candidate groups and by at least two DISTINCT papers. The paper detail "
        "view supports single-paper suggestions. Merge catalog entries only if the eligibility rules mean "
        "the same thing, never just because topics overlap. Merge from can_merge_from=true entries only; "
        "prefer user-defined targets. Do not delete tags. Return the ENTIRE revised proposal, not a delta. "
        "Return JSON {creates:[{name,rule,reason,candidates:[integer candidate IDs]}], "
        "merges:[{source:integer catalog ID,target:integer catalog ID,reason}],reply:string}. "
        "Reply concisely in the requested language. If the feedback cannot be supported by evidence, explain why."
    )
    result = paper_labeling._ask(instruction, data, cancel=cancel, cfg=cfg)
    creates, merges = result.get("creates"), result.get("merges")
    if not isinstance(creates, list) or not isinstance(merges, list):
        raise ValueError(tr("模型没有返回可用的标签结果，请重试"))
    proposals = []
    used = {s.casefold() for label in labels for s in (label.name, *label.aliases)}
    for entry in creates:
        if not isinstance(entry, dict):
            continue
        candidates = paper_labels.generated_candidates({}, [entry])
        if not candidates or candidates[0].name.casefold() in used:
            continue
        refs = entry.get("candidates")
        if not isinstance(refs, list) or not refs or any(type(i) is not int or not 0 <= i < len(groups) for i in refs):
            continue
        label = candidates[0]
        papers = {pid: paper for i in refs for pid, paper in groups[i].items()}
        if len(papers) < 2:
            continue
        used.add(label.name.casefold())
        proposals.append({"kind": "create", "id": _id("new", label.name), **label.fields(),
                          "reason": _text(entry.get("reason")), "papers": list(papers.values())})
    sources, targets = set(), set()
    for entry in merges:
        if not isinstance(entry, dict):
            continue
        source, target = entry.get("source"), entry.get("target")
        if any(type(i) is not int or not 0 <= i < len(labels) for i in (source, target)):
            continue
        if source == target or source in sources | targets or target in sources or labels[source].origin != "ai":
            continue
        sources.add(source)
        targets.add(target)
        src, dst = labels[source], labels[target]
        affected = []
        for record in records:
            names = {n.casefold(): n for n in record.get("labels", [])}
            if src.name.casefold() in names:
                proof = record.get("proof", {}).get(names[src.name.casefold()]) or {}
                affected.append({"id": record["id"], "title": record["title"],
                                 **{k: proof[k] for k in ("quote", "page", "anchor") if k in proof}})
        proposals.append({"kind": "merge", "id": _id("merge", src.name, dst.name), "source": src.name,
                          "target": dst.name, "source_rule": src.rule, "target_rule": dst.rule,
                          "reason": _text(entry.get("reason")), "papers": affected})
    return proposals, _text(result.get("reply"))


def _text(value):
    return value.strip()[:1800] if isinstance(value, str) else ""
