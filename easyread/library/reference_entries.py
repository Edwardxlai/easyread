"""Merge printed bibliography entries across batches and retries."""
import hashlib
from collections import Counter


def _content_id(text: str) -> str:
    letters = "".join(c for c in text.casefold() if c.isalnum())
    return "r" + hashlib.sha1(letters.encode()).hexdigest()[:8]


def merge_references(existing: list, incoming: list) -> list:
    # Retries may supply a printed key for an old unnumbered entry. Match its
    # text first, without conflating two different entries that share a key.
    by_text = {}
    for entry in [*existing, *incoming]:
        if not isinstance(entry, dict):
            continue
        text = " ".join(str(entry.get("text") or "").split())
        if not text:
            continue
        key = str(entry.get("cite_key") or entry.get("id") or "").strip()
        if not entry.get("cite_key") and key.rstrip("x") == _content_id(text):
            key = ""
        variants = by_text.setdefault(text, {})
        if key not in variants:
            variants[key] = dict(entry)
        elif entry.get("page") and (not variants[key].get("page") or entry["page"] < variants[key]["page"]):
            variants[key]["page"] = entry["page"]

    entries = [(text, key, entry) for text, variants in by_text.items()
               for key, entry in variants.items() if key or len(variants) == 1]
    counts = Counter(key for _, key, _ in entries if key)
    used = set(counts)
    result = []
    for text, key, entry in entries:
        if key and counts[key] == 1:
            entry["id"] = key
        else:
            # A collision needs separate reader anchors but retains its printed
            # key so the reader can leave ambiguous citations unlinked.
            if key:
                entry["cite_key"] = key
            ident = _content_id(text)
            while ident in used:
                ident += "x"
            entry["id"] = ident
            used.add(ident)
        result.append(entry)
    return sorted(result, key=lambda r: r.get("page") or 0)
