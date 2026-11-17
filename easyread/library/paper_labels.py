"""Reusable literature labels and the assignments stored in each item.json."""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass

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
            labels.setdefault(name.casefold(), Label(name, _rule(raw_rule)))
        return labels
    except (OSError, ValueError) as exc:
        raise DataReadError(path) from exc


def _save(root, labels: dict[str, Label]) -> None:
    write_json_atomic(root / CATALOG, {label.name: label.rule for label in labels.values()})


def _include_assignments(names: dict[str, Label], items) -> None:
    for item in items:
        for key, name in _by_name(item.get("labels")).items():
            names.setdefault(key, Label(name))


def summarize(root, items: list[dict]) -> list[str]:
    try:
        names = _registry(root)
    except DataReadError:
        names = {}  # A damaged catalog should still allow browsing papers and their assigned labels.
    _include_assignments(names, items)
    for item in items:
        item["labels"] = [names[key].name for key in _by_name(item.get("labels"))]
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


def unassigned(library, item: dict) -> list[Label]:
    labels = available(library)
    if not labels:
        raise ValueError(tr("请先创建至少一个论文标签"))
    attached = _by_name(item.get("labels"))
    return [labels[key] for key in sorted(labels) if key not in attached]


def _requested(values) -> list[str]:
    if not isinstance(values, list):
        raise ValueError(tr("论文标签必须是数组"))
    names = [_normalize(value) for value in values]
    if not all(names):
        raise ValueError(tr("标签名称须为 1 至 60 个字符"))
    return names


def _register(root, requested: list[str], rules: dict[str, str]) -> list[str]:
    if not requested:
        return []
    with dir_lock(root, name=_LOCK):
        labels = _registry(root)
        size = len(labels)
        canonical = []
        for name in requested:
            key = name.casefold()
            label = labels.setdefault(key, Label(name, rules.get(key, "")))
            if key in rules and label.rule != rules[key]:
                raise ValueError(tr("标签规则已存在，请重新打开编辑标签后修改"))
            canonical.append(label.name)
        if len(labels) != size:
            _save(root, labels)
        return canonical


def create(root, value) -> dict:
    return {"name": _register(root, _requested([value]), {})[0]}


def _lookup(library, key: str) -> Label | None:
    label = _registry(library.root).get(key)
    # Merged papers may carry a label before its first rule is saved in this library.
    return label or available(library).get(key)


def definitions(library, name=None) -> dict:
    if name is not None:
        key = _normalize(name).casefold()
        label = _lookup(library, key) if key else None
        return {"labels": [label.fields()] if label else []}
    labels = available(library)
    return {"labels": [labels[key].fields() for key in sorted(labels)]}


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
        current = labels.get(key, original)
        if previous is not None and current.rule not in (previous, rule):
            raise ValueError(tr("规则已在另一处修改，请重新打开查看最新规则后再保存"))
        saved = Label(current.name, rule)
        if labels.get(key) != saved:
            labels[key] = saved
            _save(library.root, labels)
    return saved.fields()


def apply(ws, add: list[str], remove: list[str] | None = None, *, finish_translation: bool = False) -> dict:
    def update(item):
        names = _by_name(item.get("labels"))
        before = list(names.values())
        if finish_translation and item.get(TRANSLATION_DONE) is True:
            return {"labels": before, "added": []}
        for name in remove or []:
            names.pop(name.casefold(), None)
        added = []
        for key, name in _by_name(add).items():
            if key not in names:
                names[key] = name
                added.append(name)
        labels = list(names.values())
        if labels != before or finish_translation:
            item.update(labels=labels, updated=now_iso())
        if finish_translation:
            item[TRANSLATION_DONE] = True
        return {"labels": labels, "added": added}

    return ws.update("item", update)


def edit(root, ws, body: dict) -> dict:
    add = _requested(body.get("add", []))
    remove = _requested(body.get("remove", []))
    raw_rules = body.get("new_rules", {})
    if not isinstance(raw_rules, dict) or raw_rules.keys() - set(add):
        raise ValueError(tr("新标签规则须对应待添加的标签"))
    rules = {name.casefold(): _rule(rule) for name, rule in raw_rules.items()}
    return apply(ws, _register(root, add, rules), remove)


def _apply_names(ws, names: list[str], *, finish_translation: bool = False) -> list[str]:
    if not names and not finish_translation:
        return []
    if not ws.paper_path.is_file():
        raise ValueError(tr("没有这篇论文"))
    return apply(ws, names, finish_translation=finish_translation)["added"]


def apply_matches(root, ws, matches: list[Label], *, translation_catalog=None, assigned=None) -> list[str]:
    if not matches:
        return []
    with dir_lock(root, name=_LOCK):
        labels = _registry(root)
        # A user may remove a previously attached label while the model is classifying.
        attached = _by_name(assigned)
        current = []
        for label in matches:
            key = label.name.casefold()
            latest = labels.get(key, Label(label.name))
            if latest.rule == label.rule and key not in attached:
                current.append(latest.name)
        finish = translation_catalog is not None
        if finish and any(translation_catalog.get(key) != label for key, label in labels.items()):
            if (ws.load("item") or {}).get(TRANSLATION_DONE) is True:
                return []
            finish = False  # Apply still-valid matches. The next translation can evaluate changed rules.
        return _apply_names(ws, current, finish_translation=finish)


def generated_candidates(known: dict[str, Label], proposals: list) -> list[Label]:
    new = {}
    for proposal in proposals:
        if not isinstance(proposal, dict):
            continue
        name = _normalize(proposal.get("name"))
        try:
            rule = _rule(proposal.get("rule"))
        except ValueError:
            continue
        key = name.casefold()
        if name and rule and key not in known:
            new.setdefault(key, Label(name, rule))
    return list(new.values())


def apply_generated(root, ws, known: dict[str, Label], proposals: list, *, finish_translation: bool = False) -> list[str]:
    new = generated_candidates(known, proposals)
    if not new and (not finish_translation or proposals):
        return []
    with dir_lock(root, name=_LOCK):
        labels = _registry(root)
        if finish_translation:
            if (ws.load("item") or {}).get(TRANSLATION_DONE) is True:
                return []
            if any(known.get(key) != label for key, label in labels.items()):
                return []  # The model did not see the latest rules. Wait for the next translation pass.
        added = [label for label in new if label.name.casefold() not in labels][:GENERATED_LIMIT]
        if not added and (not finish_translation or proposals):
            return []
        if not ws.paper_path.is_file():
            raise ValueError(tr("没有这篇论文"))
        if added:
            labels.update({label.name.casefold(): label for label in added})
            _save(root, labels)
        return _apply_names(ws, [label.name for label in added], finish_translation=finish_translation)
