"""Read EasyRead's maintenance queue and checkpoint only a reviewed snapshot."""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


REPO = "Edwardxlai/easyread"
ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local/state") / "EasyRead-maintainer" / "queue.sqlite3"


def run(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, check=True,
                          encoding="utf-8", timeout=45).stdout.strip()


def gh(*args):
    return json.loads(run("gh", *args))


def open_items(kind):
    extra = """
        headRefOid baseRefName isDraft reviewDecision mergeable
        commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    """ if kind == "pullRequests" else ""
    query = """
        query($endCursor:String) { repository(owner:"Edwardxlai",name:"easyread") {
          COLLECTION(states:OPEN,first:100,after:$endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes { number title url updatedAt EXTRA
              comments(last:1) { nodes { id updatedAt author { login } } }
            }
          }
        } }
    """.replace("COLLECTION", kind).replace("EXTRA", extra)
    pages = gh("api", "graphql", "--paginate", "--slurp", "-f", "query=" + query)
    items = {}
    for page in pages:
        if page.get("errors"):
            raise ValueError(str(page["errors"]))
        for item in page["data"]["repository"][kind]["nodes"]:
            item["kind"] = "PR" if extra else "issue"
            if extra:
                # A fork workflow awaiting approval can have no check rollup at all.
                path = f"repos/{REPO}/actions/workflows/test.yml/runs"
                runs = gh("api", f"{path}?event=pull_request&head_sha={item['headRefOid']}&per_page=1")
                item["testRun"] = next(({k: r[k] for k in ("id", "status", "conclusion", "run_attempt")}
                                        for r in runs["workflow_runs"]), None)
            items[str(item["number"])] = item
    return items


def release_state():
    latest = gh("release", "view", "-R", REPO, "--json", "tagName,url")
    version = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", latest["tagName"])
    candidates = {}
    for line in run("git", "for-each-ref", "--format=%(refname:short) %(objectname)",
                    "refs/heads").splitlines():
        name, sha = line.split()
        match = re.fullmatch(r"(?:codex/)?release[-/](\d+)[.-](\d+)[.-](\d+)", name)
        if match and (not version or tuple(map(int, match.groups())) > tuple(map(int, version.groups()))):
            candidates[name] = sha
    builds = gh("run", "list", "-R", REPO, "-w", "release.yml", "-L", "1",
                "--json", "databaseId,status,conclusion,headSha,url")
    return {"published": latest, "main": run("gh", "api", f"repos/{REPO}/commits/main",
                                              "--jq", ".sha"),
            "candidateBranches": candidates, "lastBuild": builds}


def current(db):
    return db.execute("SELECT id, data FROM baseline WHERE slot=1").fetchone()


def merged_since(since):
    """Include PRs opened and merged entirely between two visits."""
    merged = []
    page = 1
    while True:
        rows = gh("api", f"repos/{REPO}/pulls?state=closed&base=main&sort=updated"
                  f"&direction=desc&per_page=100&page={page}")
        for pr in rows:
            if pr["updated_at"] < since:
                return merged
            if pr["merged_at"] and pr["merged_at"] >= since:
                merged.append({"number": pr["number"], "title": pr["title"],
                               "url": pr["html_url"], "mergedAt": pr["merged_at"],
                               "mergeSHA": pr["merge_commit_sha"]})
        if len(rows) < 100:
            return merged
        page += 1


def scan(db, all_open=False):
    baseline = current(db)
    old = json.loads(baseline[1]) if baseline else {"items": {}, "release": {}}
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    since = old.get("scannedAt", started)
    if baseline and "scannedAt" not in old and old["release"].get("main"):
        since = run("gh", "api", f"repos/{REPO}/commits/{old['release']['main']}",
                    "--jq", ".commit.committer.date")
    recent = merged_since(since)
    seen = set(old.get("mergeReceipts", []))
    if not old.get("scannedAt"):
        seen.add(old["release"].get("main"))
    new_merges = [pr for pr in recent if pr["mergeSHA"] not in seen]
    items = open_items("issues") | open_items("pullRequests")
    release = release_state()
    data = json.dumps({"items": items, "release": release, "scannedAt": started,
                       "mergeReceipts": [pr["mergeSHA"] for pr in recent]}, ensure_ascii=False)
    scan_id = uuid.uuid4().hex
    with db:
        db.execute("INSERT INTO scans VALUES(?,?,?)", (scan_id, baseline[0] if baseline else "", data))
    revisit = all_open or "scannedAt" not in old
    changed = [item for n, item in items.items() if revisit or item != old["items"].get(n)]
    gone = [item for n, item in old["items"].items() if n not in items]
    due = [n for n, in db.execute("SELECT number FROM followup WHERE due<=?", (date.today().isoformat(),))
           if n in items]
    return {"scan": scan_id, "initial": not baseline, "openIssues": sum(x["kind"] == "issue" for x in items.values()),
            "openPRs": sum(x["kind"] == "PR" for x in items.values()), "changed": changed,
            "noLongerOpen": gone, "followUpDue": due, "merged": new_merges,
            "releaseChanges": {k: v for k, v in release.items() if old["release"].get(k) != v}}


def acknowledge(db, scan_id, follow):
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT parent, data FROM scans WHERE id=?", (scan_id,)).fetchone()
        previous = current(db)
        if previous and previous[0] == scan_id:
            return {"reviewed": scan_id}
        if not row or row[0] != (previous[0] if previous else ""):
            raise ValueError("Snapshot superseded or missing. Scan again before acknowledging.")
        items = json.loads(row[1])["items"]
        for number, days in follow:
            days = int(days)
            if number not in items or days < 0:
                raise ValueError("Follow-up requires an open item and nonnegative days.")
            db.execute("DELETE FROM followup WHERE number=?", (number,))
            if days:
                due = (date.today() + timedelta(days=days)).isoformat()
                db.execute("INSERT INTO followup VALUES(?,?)", (number, due))
        for number, in db.execute("SELECT number FROM followup").fetchall():
            if number not in items:
                db.execute("DELETE FROM followup WHERE number=?", (number,))
        db.execute("INSERT OR REPLACE INTO baseline VALUES(1,?,?)", (scan_id, row[1]))
        db.execute("DELETE FROM scans WHERE parent=?", (row[0],))
    return {"reviewed": scan_id}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="action", required=True)
    scan_args = modes.add_parser("scan")
    scan_args.add_argument("--all", action="store_true", help="also return previously seen open items")
    ack = modes.add_parser("ack")
    ack.add_argument("scan_id")
    ack.add_argument("--follow", nargs=2, metavar=("NUMBER", "DAYS"), action="append", default=[])
    args = parser.parse_args()
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(STATE) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS baseline(slot INTEGER PRIMARY KEY, id TEXT, data TEXT);
            CREATE TABLE IF NOT EXISTS scans(id TEXT PRIMARY KEY, parent TEXT, data TEXT);
            CREATE TABLE IF NOT EXISTS followup(number TEXT PRIMARY KEY, due TEXT);
        """)
        result = scan(db, args.all) if args.action == "scan" else acknowledge(db, args.scan_id, args.follow)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.stderr.strip() or str(error))
