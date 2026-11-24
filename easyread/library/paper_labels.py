"""Reusable literature labels and the assignments stored in each item.json."""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass, replace

from ..app.i18n import tr
from .store import DataReadError, dir_lock, now_iso, read_json, write_json_atomic

CATALOG = ".paper-labels.json"
MAX_NAME = 60
MAX_RULE = 1000
GENERATED_LIMIT = 3
TRANSLATION_DONE = "translation_labels_done"
_LOCK = ".paper-labels.lock"


@dataclass(frozen=True)
class Label:
    name: str
    rule: str = ""
    origin: str = "user"
    aliases: tuple[str, ...] = ()

    def fields(self) -> dict[str, str]:
        return {"name": self.name, "rule": self.rule}


def _normalize(value) -> str:
    if not isinstance(value, str):
        return ""
    name = unicodedata.normalize("NFC", " ".join(value.split()))
    if len(name) > MAX_NAME or any(unicodedata.category(c) in ("Cc", "Cs") for c in name):
        return ""
    return name


def _by_name(values) -> dict[str, str]:
    names = {}
    for value in values if isinstance(values, list) else []:
        name = _normalize(value)
        if name:
            names.setdefault(name.casefold(), name)
    return names


def _rule(value) -> str:
    if not isinstance(value, str):
        raise ValueError(tr("标签规则须为 1000 字以内的文本"))
    rule = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(rule) > MAX_RULE or any(c not in "\n\t" and unicodedata.category(c) in ("Cc", "Cs") for c in rule):
        raise ValueError(tr("标签规则须为 1000 字以内的文本"))
    return rule


def _registry(root) -> dict[str, Label]:
    path = root / CATALOG
    try:
        values = read_json(path, {})
        if isinstance(values, list):
            entries = ((value, "") for value in values)  # Existing catalogs only stored names.
        elif isinstance(values, dict):
            entries = values.items()
        else:
            raise ValueError("invalid label catalog")
        labels = {}
        for raw_name, raw_rule in entries:
            name = _normalize(raw_name)
            if not name:
                raise ValueError("invalid label name")
            record = raw_rule if isinstance(raw_rule, dict) else {"rule": raw_rule}
            labels.setdefault(name.casefold(), Label(name, _rule(record.get("rule", "")),
                                                     "ai" if record.get("origin") == "ai" else "user",
                                                     tuple(_by_name(record.get("aliases")).values())))
        return labels
    except (OSError, ValueError) as exc:
        raise DataReadError(path) from exc


def _save(root, labels: dict[str, Label]) -> None:
    write_json_atomic(root / CATALOG, {
        label.name: ({"rule": label.rule, "origin": label.origin, "aliases": list(label.aliases)}
                     if label.origin == "ai" or label.aliases else label.rule)
        for label in labels.values()})


def _aliases(labels):
    return {alias.casefold(): label for label in labels.values() for alias in label.aliases}


def _item_labels(item, lookup):
    # Catalog aliases take effect immediately, even while a bulk merge is moving papers.
    def canonical(name):
        label = lookup.get(name.casefold())
        return label.name if label else name

    assigned = _by_name([canonical(name) for name in _by_name(item.get("labels")).values()])
    excluded = _by_name([canonical(name) for name in _by_name(item.get("label_exclusions")).values()])
    evidence = {canonical(name): row for name, row in (item.get("label_evidence") or {}).items()}
    return assigned, excluded, evidence


def _include_assignments(names: dict[str, Label], items) -> None:
    aliases = _aliases(names)
    for item in items:
        for key, name in _by_name(item.get("labels")).items():
            if key not in aliases:
                names.setdefault(key, Label(name))


def summarize(root, items: list[dict]) -> list[str]:
    try:
        names = _registry(root)
    except DataReadError:
        names = {}  # A damaged catalog should still allow browsing papers and their assigned labels.
    _include_assignments(names, items)
    lookup = {**_aliases(names), **names}
    for item in items:
        attached = list(dict.fromkeys(lookup[key] for key in _by_name(item.get("labels"))))
        item["labels"] = [label.name for label in attached]
        item["label_aliases"] = [alias for label in attached for alias in label.aliases]
        recorded = {lookup[key].name for key in _by_name(item.get("evidence_labels")) if key in lookup}
        item["evidence_labels"] = [label.name for label in attached if label.name in recorded]
    return sorted((label.name for label in names.values()), key=str.casefold)


def available(library) -> dict[str, Label]:
    labels = _registry(library.root)
    # Assigned names travel with a paper, including papers merged from a different library.
    for workspace in library.all():
        try:
            _include_assignments(labels, [workspace.load("item") or {}])
        except DataReadError:
            continue
    return labels


def _requested(values) -> list[str]:
    if not isinstance(values, list):
        raise ValueError(tr("论文标签必须是数组"))
    names = [_normalize(value) for value in values]
    if not all(names):
        raise ValueError(tr("标签名称须为 1 至 60 个字符"))
    return names


def _register(root, labels, requested: list[str], rules: dict[str, str]) -> list[str]:
    size = len(labels)
    canonical = []
    aliases = _aliases(labels)
    for name in requested:
        key = name.casefold()
        label = aliases.get(key) or labels.setdefault(key, Label(name, rules.get(key, "")))
        if key in rules and label.rule != rules[key]:
            raise ValueError(tr("标签规则已存在，请重新打开编辑标签后修改"))
        canonical.append(label.name)
    if len(labels) != size:
        _save(root, labels)
    return canonical


def create(root, value) -> dict:
    with dir_lock(root, name=_LOCK):
        return {"name": _register(root, _registry(root), _requested([value]), {})[0]}


def _lookup(library, key: str) -> Label | None:
    labels = _registry(library.root)
    label = labels.get(key) or _aliases(labels).get(key)
    # Merged papers may carry a label before its first rule is saved in this library.
    return label or available(library).get(key)


def definitions(library, name=None) -> dict:
    if name is not None:
        key = _normalize(name).casefold()
        label = _lookup(library, key) if key else None
        return {"labels": [label.fields()] if label else []}
    labels = available(library)
    return {"labels": [labels[key].fields() for key in sorted(labels)]}


def saved_evidence(library, ws, name):
    """Resolve the current name and read its recorded quotation without calling a model."""
    key = _requested([name])[0].casefold()
    with dir_lock(library.root, name=_LOCK):
        catalog = _registry(library.root)
        lookup = {**_aliases(catalog), **catalog}
        item = ws.load("item") or {}
        assigned, _, records = _item_labels(item, lookup)
        label = lookup.get(key) or Label(assigned.get(key, ""))
        proof = records.get(label.name) or {}
        if label.name.casefold() not in assigned or not proof.get("quote"):
            raise ValueError(tr("这篇论文没有这个标签的已存依据"))
        return {**label.fields(), **{field: proof.get(field) for field in ("page", "anchor", "quote")}}


def set_rule(library, body: dict) -> dict:
    name = _requested([body.get("name")])[0]
    rule = _rule(body.get("rule"))
    previous = _rule(body["previous_rule"]) if "previous_rule" in body else None
    key = name.casefold()
    original = _lookup(library, key)
    if original is None:
        raise ValueError(tr("找不到这个论文标签"))
    with dir_lock(library.root, name=_LOCK):
        labels = _registry(library.root)
        current = labels.get(key) or _aliases(labels).get(key) or original
        key = current.name.casefold()
        if name.casefold() != key:
            raise ValueError(tr("标签已并入其他标签，请刷新后重试"))
        if previous is not None and current.rule not in (previous, rule):
            raise ValueError(tr("规则已在另一处修改，请重新打开查看最新规则后再保存"))
        saved = replace(current, rule=rule, origin="user")
        if labels.get(key) != saved:
            labels[key] = saved
            _save(library.root, labels)
    return saved.fields()


def edit(root, ws, body: dict) -> dict:
    add = _requested(body.get("add", []))
    remove = _requested(body.get("remove", []))
    raw_rules = body.get("new_rules", {})
    if not isinstance(raw_rules, dict) or raw_rules.keys() - set(add):
        raise ValueError(tr("新标签规则须对应待添加的标签"))
    rules = {name.casefold(): _rule(rule) for name, rule in raw_rules.items()}
    with dir_lock(root, name=_LOCK):
        labels = _registry(root)
        aliases = _aliases(labels)
        canonical = _register(root, labels, add, rules)
        remove = [aliases[n.casefold()].name if n.casefold() in aliases else n for n in remove]

        def update(item):
            names, excludes, evidence = _item_labels(item, {**aliases, **labels})
            for n in remove:
                real = names.pop(n.casefold(), n)
                excludes[real.casefold()] = real
                evidence.pop(real, None)
            added = []
            for n in canonical:
                excludes.pop(n.casefold(), None)
                if n.casefold() not in names:
                    names[n.casefold()] = n
                    added.append(n)
            item.update(labels=list(names.values()), label_exclusions=list(excludes.values()),
                        label_evidence=evidence, updated=now_iso())
            return {"added": added, "labels": item["labels"]}
        return ws.update("item", update)


def generated_entries(known: dict[str, Label], proposals):
    reserved = known.keys() | _aliases(known).keys()
    for proposal in proposals:
        if not isinstance(proposal, dict):
            continue
        name = _normalize(proposal.get("name"))
        try:
            rule = _rule(proposal.get("rule"))
        except ValueError:
            continue
        key = name.casefold()
        if name and rule and key not in reserved:
            reserved.add(key)
            yield Label(name, rule, origin="ai"), proposal


def generated_candidates(known: dict[str, Label], proposals: list) -> list[Label]:
    return [label for label, _ in generated_entries(known, proposals)]


def save_analysis(library, ws, result, known, *, auto=True, checked_pages=None, complete=False, organizer_job=None):
    """Commit a validated analysis against the current catalog and manual exclusions."""
    with dir_lock(library.root, name=_LOCK):
        catalog = _registry(library.root)
        aliases = _aliases(catalog)
        stable = all(known.get(k) == label for k, label in catalog.items())
        matches = []
        for row in result["matches"]:
            key = row["name"].casefold()
            current = catalog.get(key) or known.get(key)
            if current is not None and key not in aliases and current.rule == row["rule"]:
                matches.append(row)
            elif not auto:
                raise ValueError(tr("标签规则已变化，请重新预览"))
        additions = {}
        for row in result["suggestions"]:
            key = row["name"].casefold()
            current = catalog.get(key)
            if not current and key not in aliases and (stable or (auto and checked_pages is None)):
                additions[key] = Label(row["name"], _rule(row["rule"]), row.get("origin", "ai"))
                matches.append(row)
            elif current and current.rule == row["rule"] and not auto:
                matches.append(row)
            elif not auto:
                raise ValueError(tr("标签库已变化，请重新预览"))
        if not ws.paper_path.is_file():
            raise ValueError(tr("没有这篇论文"))

        def update(item):
            names, exclusions, evidence = _item_labels(item, {**aliases, **catalog})
            added = []
            for row in matches:
                name = row["name"]
                key = name.casefold()
                if auto and key in exclusions:
                    continue
                if key in additions:
                    catalog[key] = additions[key]
                if key not in names:
                    names[key] = name
                    added.append(name)
                if not auto:
                    exclusions.pop(key, None)
                evidence[names[key]] = {field: row[field] for field in ("quote", "page", "anchor")}
            if any(key in catalog for key in additions):
                _save(library.root, catalog)
            item.update(labels=list(names.values()), label_evidence=evidence, updated=now_iso())
            if organizer_job:
                # The library checkpoint may still be pending if the process exits after this write.
                item["label_organizer_receipt"] = {"job": organizer_job, "added": len(added)}
            if exclusions or "label_exclusions" in item:
                item["label_exclusions"] = list(exclusions.values())
            if checked_pages is not None and stable:
                item["label_checked_pages"] = sorted(checked_pages)
                item[TRANSLATION_DONE] = complete
            return {"added": added, "labels": item["labels"]}
        return ws.update("item", update)
