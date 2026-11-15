"""Select relevant checks for a diff. --run executes the mapped fast tests."""
import argparse
import fnmatch
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def paths_from_git(*args):
    raw = subprocess.check_output(["git", *args], cwd=ROOT)
    return [os.fsdecode(name) for name in raw.split(b"\0") if name]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="HEAD")
    parser.add_argument("--head", help="committed PR head; omit for local changes")
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    target = f"{args.base}...{args.head}" if args.head else args.base
    paths = set(paths_from_git("diff", "--name-only", "-z", "--no-renames", target, "--"))
    if not args.head:
        paths.update(paths_from_git("ls-files", "-z", "--others", "--exclude-standard"))
    rules = json.loads((ROOT / "maintenance/checks.json").read_text(encoding="utf-8"))
    covered = set()
    selected = []
    for rule in rules:
        matched = {path for path in paths if any(fnmatch.fnmatchcase(path, pattern)
                   for pattern in rule["paths"])}
        if matched:
            print(f"{rule['area']} ({len(matched)}): {rule['evidence']}")
            covered.update(matched)
            selected.extend(rule["tests"])
    for path in sorted(paths - covered):
        print(f"{path}: 维护者选择对应验证，保留常规 CI")
    for test in dict.fromkeys(selected):
        cmd = ["node", "--test", test] if test.endswith(".cjs") else [sys.executable, "-m", "unittest", test]
        print(" ".join(cmd), flush=True)
        if args.run:
            subprocess.run(cmd, cwd=ROOT, check=True)
    if not paths:
        print("没有改动")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
