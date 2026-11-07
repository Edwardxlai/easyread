"""Limit a model repair to the blocks or fill keys reported by the validator."""
from __future__ import annotations

import json
import re

from ..engines import engines
from . import prompts
from .repair_guard import retains_content


def repair(data: dict, field: str, problems: list[str], run, validate, normalize=None) -> dict:
    blocks = field == "blocks"
    items = {b["id"]: b for b in data[field]} if blocks else data[field]
    ids = {re.split(r"[:：]", problem, maxsplit=1)[0] for problem in problems}
    # An unscoped diagnostic still needs the entire set of blocks or fill keys.
    selected = {k: v for k, v in items.items() if k in ids} if ids <= items.keys() else items
    subset = {field: list(selected.values()) if blocks else selected}
    payload = json.dumps(subset, ensure_ascii=False, separators=(",", ":"))
    result = engines.parse_json(run(prompts.repair(payload, problems)))
    if blocks and isinstance(result, list):
        result = {field: result}
    fixed = result.get(field) if isinstance(result, dict) else None
    if blocks:
        if not isinstance(fixed, list) or not all(isinstance(b, dict) and isinstance(b.get("id"), str) for b in fixed):
            return data
        by_id = {b["id"]: b for b in fixed}
        if len(by_id) != len(fixed):
            return data
    elif isinstance(fixed, dict):
        by_id = fixed
    else:
        return data
    if normalize and blocks:
        normalized = normalize({"blocks": list(by_id.values())})
        by_id = {b["id"]: b for b in normalized["blocks"]}
    if not selected.keys() <= by_id.keys():
        return data
    replacements = {k: by_id[k] for k in selected}
    if not retains_content(subset, {field: list(replacements.values()) if blocks else replacements}):
        return data
    merged = {**items, **replacements}
    candidate = {**data, field: list(merged.values()) if blocks else merged}
    return candidate if len(validate(candidate)) < len(problems) else data
