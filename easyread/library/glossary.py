"""Validation shared by saved papers and incoming translation batches."""


def valid_entries(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict)
            and all(isinstance(entry.get(key), str) and entry[key].strip() for key in ("en", "zh"))]


def merge_glossary(paper: dict, incoming) -> None:
    new = valid_entries(incoming)
    if not new:
        return
    glossary = paper.setdefault("glossary", [])
    have = {entry["en"] for entry in glossary}
    for entry in new:
        if entry["en"] not in have:
            glossary.append(entry)
            have.add(entry["en"])
