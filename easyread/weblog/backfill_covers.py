"""Generate missing covers from saved web articles in an existing library."""
import argparse
from pathlib import Path

from ..library.library import Library
from .cover import COVER, ensure


def backfill(library):
    for ws in library.all():
        if (ws.root / COVER).is_file() or not (ws.root / "source.html").is_file():
            continue
        paper = ws.load("paper")
        if paper and paper.get("meta", {}).get("source_type") == "web":
            ensure(ws, paper)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path, help="Existing EasyRead library directory")
    directory = parser.parse_args().library
    if not directory.is_dir():
        parser.error("Library directory does not exist")
    backfill(Library(directory))
