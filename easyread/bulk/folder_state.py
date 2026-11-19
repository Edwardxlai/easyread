"""Validate saved mappings without repairing or overwriting unreadable state."""
import re
from pathlib import Path

from ..library.store import DataReadError, read_json


def _strings(value):
    return isinstance(value, list) and all(isinstance(part, str) for part in value)


def read_mappings(path: Path) -> dict:
    try:
        roots = read_json(path, {})
        if not isinstance(roots, dict):
            raise ValueError("Expected a mapping object")
        for name, watch in roots.items():
            if not isinstance(watch, dict) or re.search(r"[/\\\x00-\x1f]", name):
                raise ValueError("Invalid mapping")
            if not isinstance(watch.get("path"), str) or not Path(watch["path"]).is_absolute():
                raise ValueError("Expected an absolute folder path")
            if any(key in watch and type(watch[key]) is not bool
                   for key in ("enabled", "translate", "network_metadata")):
                raise ValueError("Invalid automatic processing option")
            if "enabled" not in watch:
                raise ValueError("Missing automatic import option")
            if not _strings(watch.get("folders")) or "" not in watch["folders"]:
                raise ValueError("Invalid folder list")
            if watch.get("backlog") is not None and not _strings(watch["backlog"]):
                raise ValueError("Invalid import backlog")
            if not isinstance(watch.get("files"), dict):
                raise ValueError("Invalid file list")
            for record in watch["files"].values():
                if (not isinstance(record, dict) or not isinstance(record.get("id"), str)
                        or not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", record["id"])):
                    raise ValueError("Invalid paper reference")
                stamp = record.get("stamp")
                if not isinstance(stamp, list) or len(stamp) != 4 or any(type(n) is not int for n in stamp):
                    raise ValueError("Invalid file stamp")
        return roots
    except (OSError, ValueError, TypeError) as err:
        raise DataReadError(path) from err


def import_only_paths(watch, observed, previous, limit):
    if watch.get("backlog") is None:
        return set(observed)  # first scan after enabling a watch
    backlog = set(watch["backlog"]).intersection(observed)
    # On restart the last imported stamps stand in for the previous observation.
    changed = {path for path, stamp in observed.items()
               if stamp != previous.get(path, watch["files"].get(path, {}).get("stamp"))}
    if len(changed) > limit:
        backlog.update(changed)
    return backlog
