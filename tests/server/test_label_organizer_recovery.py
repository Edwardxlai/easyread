"""Exercise process loss between the paper write and the organizer checkpoint over real HTTP."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path


BASE = "/api/library/labels/organize"
QUOTE = "We surveyed local residents with a structured questionnaire."


def serve_fixture(root, stop_before_checkpoint):
    from easyread.app import config
    from easyread.engines import engines
    from easyread.library import paper_labels
    from easyread.server import label_organizer
    from easyread.server.server import App, Handler

    def model(cfg, prompt, *_args, **_kwargs):
        data = json.loads(prompt.splitlines()[-1])
        with (root / "calls.jsonl").open("a", encoding="utf8") as out:
            out.write(json.dumps([data.get("title", "review"), cfg["codex"]["model"]]) + "\n")
        if "sources" in data:
            ids = {label["name"]: int(i) for i, label in data["labels"].items()}
            result = {"matches": [{"id": ids["Survey"], "source": 1, "quote": QUOTE}],
                      "suggestions": [{"name": "Local surveys", "rule": "Surveys local residents",
                                       "source": 1, "quote": QUOTE}]}
        else:
            result = {"creates": [{"name": "Local surveys", "rule": "Surveys local residents",
                                   "reason": "Supported by both articles", "candidates": [0]}],
                      "merges": [], "reply": ""}
        return json.dumps(result)

    engines.run = model
    if stop_before_checkpoint:
        save = paper_labels.save_analysis

        def stop_after_paper_write(*args, **kwargs):
            result = save(*args, **kwargs)
            (root / "paper-written").touch()
            # The driver terminates this subprocess after verifying the durable paper write.
            threading.Event().wait(30)
            return result
        paper_labels.save_analysis = stop_after_paper_write
    else:
        save_job = label_organizer.write_json_atomic

        def fail_checkpoint_once(path, job):
            if job.get("phase") == "confirm" and job.get("applied") and not (root / "fault-injected").exists():
                (root / "fault-injected").touch()
                raise OSError("fixture: temporary disk full")
            return save_job(path, job)
        label_organizer.write_json_atomic = fail_checkpoint_once

    Handler.app = App(config.load())
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as http:
        (root / "port").write_text(str(http.server_port))
        http.serve_forever()


class RecoveryHttpTest(unittest.TestCase):
    def wait_for(self, read):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = read()
            if result:
                return result
            time.sleep(.03)
        self.fail("timed out waiting for local fixture")

    def start(self, root, mode):
        port_file = root / "port"
        port_file.unlink(missing_ok=True)
        process = subprocess.Popen([sys.executable, "-m", "tests.server.test_label_organizer_recovery", str(root), mode],
                                   env={**os.environ, "EASYREAD_HOME": str(root), "EASYREAD_LIBRARY": str(root / "library")},
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        def stop():
            process.kill()
            process.wait(timeout=10)
        self.addCleanup(stop)
        self.port = int(self.wait_for(lambda: port_file.read_text() if port_file.exists() else ""))
        self.token = self.request("/api/library")["token"]
        return process

    def request(self, path, data=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET" if data is None else "POST", path, None if data is None else json.dumps(data),
                         {"Content-Type": "application/json", "X-Token": getattr(self, "token", "")})
            response = conn.getresponse()
            body = json.loads(response.read())
            self.assertEqual(response.status, 200, body)
            return body
        finally:
            conn.close()

    def until_state(self, target):
        def status():
            job = self.request(BASE)
            return job if job["state"] == target else None
        return self.wait_for(status)

    def test_hard_restart_after_assignment_then_retry_full_disk_confirmation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            models = [{"id": name, "engine": "codex", "model": name} for name in ("first", "alternate")]
            (root / "config.json").write_text(json.dumps({"chat": {"default": "first", "models": models}}))
            library = root / "library"
            for name in ("alpha", "beta"):
                paper = library / name
                paper.mkdir(parents=True)
                (paper / "paper.json").write_text(json.dumps({"meta": {"title_en": name},
                    "blocks": [{"page": 3, "type": "para", "id": "method", "en": QUOTE}]}))
            (library / ".paper-labels.json").write_text(json.dumps({"Survey": "Requires survey data"}))
            first = self.start(root, "interrupt")
            job = self.request(BASE + "/start", {})
            self.wait_for((root / "paper-written").exists)
            first.kill()
            first.wait(timeout=10)
            self.assertEqual(json.loads((library / "alpha" / "item.json").read_text(encoding="utf8"))["labels"], ["Survey"])

            second = self.start(root, "resume")
            try:
                self.assertEqual(self.until_state("paused")["id"], job["id"])
                self.request("/api/p/alpha/labels", {"remove": ["Survey"], "add": ["My review"]})
                self.request("/api/config", {"chat": {"default": "alternate"}})
                self.request(BASE + "/resume", {"id": job["id"]})
                review = self.until_state("review")
                self.assertEqual((review["done"], review["assigned"]), (2, 2))
                self.assertEqual(len(review["proposals"]), 1)
                selected = [review["proposals"][0]["id"]]
                confirm = {"id": job["id"], "revision": review["revision"], "selected": selected}
                self.request(BASE + "/confirm", confirm)
                self.assertIn("disk full", self.until_state("error")["error"])
                self.request(BASE + "/resume", {"id": job["id"]})
                self.until_state("complete")
                self.assertEqual(self.request(BASE + "/confirm", confirm)["applied"], selected)
                self.assertEqual(self.request("/api/config")["config"]["chat"]["default"], "alternate")
                calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
                self.assertEqual(calls, [["alpha", "first"], ["beta", "alternate"], ["review", "alternate"]])
                alpha = json.loads((library / "alpha" / "item.json").read_text(encoding="utf8"))
                beta = json.loads((library / "beta" / "item.json").read_text(encoding="utf8"))
                self.assertEqual(alpha["labels"], ["My review", "Local surveys"])
                self.assertEqual(alpha["label_exclusions"], ["Survey"])
                self.assertEqual(beta["labels"], ["Survey", "Local surveys"])
            finally:
                second.kill()
                second.wait(timeout=10)


if __name__ == "__main__" and len(sys.argv) == 3:
    serve_fixture(Path(sys.argv[1]), sys.argv[2] == "interrupt")
