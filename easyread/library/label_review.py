"""Apply only checked library proposals; existing user tags are always protected."""
from __future__ import annotations

from dataclasses import replace

from ..app.i18n import tr
from . import paper_labels as tags
from .store import dir_lock, now_iso


class StaleProposal(ValueError):
    """The user must review this proposal against the current catalog."""


def _stale():
    return StaleProposal(tr("标签或规则已更改，这条建议已跳过"))


def _create(library, proposal):
    root = library.root
    key = proposal["name"].casefold()
    expected = tags.Label(proposal["name"], proposal["rule"], origin="ai")
    with dir_lock(root, name=tags._LOCK):
        catalog = tags._registry(root)
        current = catalog.get(key)
        if current is None:
            # Also protect legacy tags that exist only on a paper.
            if key in tags._aliases(catalog) or key in tags.available(library):
                raise _stale()
            catalog[key] = expected
            tags._save(root, catalog)
        elif current.origin != "ai" or current.rule != expected.rule:
            raise _stale()

    for doc in proposal["papers"]:
        ws = library.ws(doc["id"])
        if ws:
            # Reload under the catalog lock so edits or merges in another window win.
            with dir_lock(root, name=tags._LOCK):
                label = tags._registry(root).get(key)
                if label is None or label.origin != "ai" or label.rule != expected.rule:
                    raise _stale()
                def assign(item):
                    names = tags._by_name(item.get("labels"))
                    if key in names or key in tags._by_name(item.get("label_exclusions")):
                        return
                    item["labels"] = [*names.values(), label.name]
                    item.setdefault("label_evidence", {})[label.name] = {
                        k: doc[k] for k in ("quote", "page", "anchor") if k in doc}
                    item["updated"] = now_iso()
                ws.update("item", assign)


def _transfer(item, old, destination):
    names = tags._by_name(item.get("labels"))
    exclusions = tags._by_name(item.get("label_exclusions"))
    # A manual exclusion of the canonical tag also applies to its aliases.
    key = destination.casefold()
    excluded = (key in exclusions or bool(old & exclusions.keys())) and key not in names
    changed = False
    if old & exclusions.keys():
        kept = {k: v for k, v in exclusions.items() if k not in old}
        if excluded:
            kept[key] = destination
        item["label_exclusions"] = list(kept.values())
        changed = True
    if old & names.keys():
        kept = {k: v for k, v in names.items() if k not in old}
        if not excluded:
            kept[key] = destination
        item["labels"] = list(kept.values())
        changed = True
    evidence = item.get("label_evidence") or {}
    for name in list(evidence):
        if name.casefold() in old:
            previous = evidence.pop(name)
            if not excluded and key in tags._by_name(item.get("labels")):
                evidence.setdefault(destination, previous)
            changed = True
    if changed:
        item["updated"] = now_iso()
    return changed


def _merge(library, proposal):
    root = library.root
    source, target = proposal["source"].casefold(), proposal["target"].casefold()
    if source == target:
        raise _stale()
    with dir_lock(root, name=tags._LOCK):
        catalog = tags._registry(root)
        aliases = tags._aliases(catalog)
        src = catalog.get(source)
        dst = catalog.get(target)
        if src is None:
            # The merge is already durable. A subsequent rule edit must be preserved while
            # we finish normalizing references left by the interrupted transfer.
            dst = dst or aliases.get(target)
            if dst is None or aliases.get(source) != dst:
                raise _stale()
        else:
            dst = dst or tags.available(library).get(target)
            if dst is None or dst.rule != proposal["target_rule"] or target in aliases:
                raise _stale()
            if src.origin != "ai" or src.rule != proposal["source_rule"]:
                raise _stale()
            dst = replace(dst, aliases=tuple(dict.fromkeys((*dst.aliases, src.name, *src.aliases))))
            catalog[target] = dst
            del catalog[source]
            tags._save(root, catalog)
    old = {s.casefold() for s in dst.aliases}
    for ws in library.all():
        item = ws.load("item") or {}
        # Avoid writing or updating timestamps on unrelated papers.
        if _transfer(item, old, dst.name):
            ws.update("item", lambda current: _transfer(current, old, dst.name))


def apply_proposal(library, proposal):
    if proposal["kind"] == "merge":
        _merge(library, proposal)
    else:
        _create(library, proposal)
