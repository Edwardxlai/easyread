"""退出回归：刷新、多标签页、暂停任务与取消阻塞中的模型请求。"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from easyread import engines, openai_api
from easyread.jobs import Jobs
from easyread.library import Library
from easyread.lifecycle import PageSessions
from easyread.store import Workspace, write_json_atomic


class PageSessionsTest(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.pages = PageSessions(True, clock=lambda: self.now)

    def test_only_last_tab_closing_starts_grace(self):
        first = self.pages.open("first")
        self.pages.open("second")
        self.pages.close("first", first)
        self.now = 100
        self.assertFalse(self.pages.expired())
        self.pages.close("second")
        self.now = 107.9
        self.assertFalse(self.pages.expired())
        self.now = 108
        self.assertTrue(self.pages.expired())
        self.assertIsNone(self.pages.open("too-late"))

    def test_refresh_and_navigation_cancel_pending_exit(self):
        self.pages.open("old-document")
        self.pages.close("old-document")
        self.now = 7
        self.pages.open("new-document")
        self.now = 200
        self.assertFalse(self.pages.expired())

    def test_stale_stream_does_not_remove_reconnected_page(self):
        old = self.pages.open("tab")
        current = self.pages.open("tab")
        self.pages.close("tab", old)
        self.assertTrue(self.pages.connected("tab", current))

    def test_browser_never_opening_does_not_leave_service_forever(self):
        self.now = 89
        self.assertFalse(self.pages.expired())
        self.now = 90
        self.assertTrue(self.pages.expired())

    def test_headless_service_stays_running(self):
        pages = PageSessions(False, clock=lambda: self.now)
        pages.open("tab")
        pages.close("tab")
        self.now = 1000
        self.assertFalse(pages.expired())


class ShutdownTest(unittest.TestCase):
    def test_stop_all_terminates_owned_cli_without_killing_other_processes(self):
        command = [sys.executable, "-c", "import time; time.sleep(60)"]
        with tempfile.TemporaryDirectory(prefix="easyread-cli-") as directory:
            unrelated = subprocess.Popen(command)
            owned = engines._popen(command, Path(directory))
            try:
                engines.stop_all()
                owned.wait(timeout=5)
                self.assertIsNone(unrelated.poll())
            finally:
                if owned.poll() is None:
                    owned.kill()
                owned.communicate(timeout=5)
                unrelated.kill()
                unrelated.wait(timeout=5)

    def test_shutdown_keeps_job_paused_when_worker_reports_a_late_error(self):
        entered = threading.Event()

        def interrupted_worker(jobs, ws, job, cancel):
            entered.set()
            cancel.wait(5)
            jobs._write(ws, state="running", message="late progress")
            raise engines.EngineError("model process exited during shutdown")

        with tempfile.TemporaryDirectory(prefix="easyread-exit-") as directory:
            lib = Library(Path(directory))
            root = lib.root / "paper"
            root.mkdir()
            write_json_atomic(root / "paper.json", {"meta": {}, "blocks": []})
            ws = Workspace(root)
            with mock.patch.object(Jobs, "_run_bulk", interrupted_worker):
                jobs = Jobs(lib)
                try:
                    jobs.enqueue(ws)
                    self.assertTrue(entered.wait(2))
                    jobs.close()
                    self.assertEqual(ws.load("job")["state"], "paused")
                finally:
                    jobs.close()

    def test_shutdown_pauses_running_and_queued_jobs_preserving_data(self):
        entered = threading.Event()

        def translate_until_cancel(jobs, ws, job, cancel):
            jobs._write(ws, state="running")
            entered.set()
            cancel.wait(5)
            raise engines.Cancelled()

        with tempfile.TemporaryDirectory(prefix="easyread-exit-") as directory:
            lib = Library(Path(directory))
            workspaces = []
            for pid in ("paper-first", "paper-second"):
                root = lib.root / pid
                root.mkdir()
                write_json_atomic(root / "paper.json", {"meta": {}, "blocks": [{"id": "p1", "zh": "已译正文"}],
                                                         "translation": {"done_pages": [1]}})
                write_json_atomic(root / "reader.json", {"paper_note": {"body": "我的笔记"}})
                workspaces.append(Workspace(root))
            with mock.patch.object(Jobs, "_run_bulk", translate_until_cancel):
                jobs = Jobs(lib)
                try:
                    jobs.enqueue(workspaces[0])
                    self.assertTrue(entered.wait(2))
                    jobs.enqueue(workspaces[1])
                    jobs.close()
                    for ws in workspaces:
                        self.assertEqual(ws.load("job")["state"], "paused")
                        self.assertEqual(ws.load("paper")["translation"]["done_pages"], [1])
                        self.assertEqual(ws.load("reader")["paper_note"]["body"], "我的笔记")
                    self.assertTrue(all(not worker.is_alive() for worker in jobs.threads))
                finally:
                    jobs.close()
                # 暂停的论文不会在再次打开应用时自动耗用模型额度。
                reopened = Jobs(lib)
                try:
                    self.assertTrue(reopened.bulk.empty())
                    self.assertEqual(workspaces[0].load("job")["state"], "paused")
                finally:
                    reopened.close()

    def test_cancel_does_not_wait_for_blocked_http_request(self):
        entered = threading.Event()
        release = threading.Event()
        cancel = threading.Event()
        finished = threading.Event()
        errors = []

        def blocked_request(*args):
            entered.set()
            release.wait(5)
            return "response"

        def run():
            try:
                engines.run_openai({}, "test", [], cancel)
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()

        with mock.patch.object(openai_api, "complete", blocked_request):
            worker = threading.Thread(target=run)
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                cancel.set()
                self.assertTrue(finished.wait(1))
                self.assertIsInstance(errors[0], engines.Cancelled)
            finally:
                release.set()
                worker.join(2)


class ServerLifecycleTest(unittest.TestCase):
    """真实子进程和 HTTP 连接；不使用读者的文献库或固定端口。"""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="easyread-service-")
        self.home = Path(self.directory.name)
        write_json_atomic(self.home / "config.json", {"engine": "none"})
        self.env = dict(os.environ, EASYREAD_HOME=str(self.home), PYTHONIOENCODING="utf-8")
        for key in ("EASYREAD_LIBRARY", "COREAD_LIBRARY"):
            self.env.pop(key, None)
        self.process = None
        self.streams = []
        self.output = (self.home / "process.log").open("w", encoding="utf-8")

    def tearDown(self):
        for stream in self.streams:
            stream.close()
        if self.process and self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)
        self.output.close()
        self.directory.cleanup()

    def start(self, exit_on_close=True):
        args = [sys.executable, "-m", "easyread", "serve", "--port", "0"]
        if exit_on_close:
            args.append("--exit-on-close")
        self.process = subprocess.Popen(args, cwd=Path(__file__).resolve().parents[1], env=self.env,
                                        stdout=self.output, stderr=subprocess.STDOUT)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            info = self.home / ".server.json"
            if info.exists():
                self.url = json.loads(info.read_text(encoding="utf-8"))["url"]
                with urllib.request.urlopen(self.url + "/api/lifecycle", timeout=3) as response:
                    lifecycle = json.load(response)
                self.token = lifecycle["token"]
                return lifecycle
            if self.process.poll() is not None:
                break
            time.sleep(0.05)
        self.fail("Server did not start: " + (self.home / "process.log").read_text(encoding="utf-8"))

    def post(self, path, body=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["X-Token"] = token
        request = urllib.request.Request(self.url + path, data=json.dumps(body or {}).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def session(self, page):
        stream = urllib.request.urlopen(self.url + "/api/session?token=" + self.token + "&page=" + page, timeout=15)
        self.streams.append(stream)
        self.assertEqual(stream.readline().strip(), b"data: connected")
        return stream

    def assert_stopped(self):
        self.assertEqual(self.process.wait(timeout=15), 0)
        self.assertFalse((self.home / ".server.json").exists())
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", int(self.url.rsplit(":", 1)[1])))

    def test_shutdown_requires_token_and_notifies_all_tabs(self):
        self.start()
        first, second = self.session("first"), self.session("second")
        for path in ("/api/shutdown", "/api/session/close"):
            for token in (None, "wrong"):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.post(path, {"page": "first"}, token)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
        self.assertIsNone(self.process.poll())
        self.post("/api/shutdown", token=self.token)
        for stream in (first, second):
            self.assertIn(b"event: shutdown", stream.read())
        self.assert_stopped()

    def test_last_session_closing_exits_after_grace_and_releases_port(self):
        self.start()
        self.session("tab")
        self.post("/api/session/close", {"page": "tab"}, self.token)
        time.sleep(0.2)
        self.assertIsNone(self.process.poll())  # 导航缓冲期间仍能连接
        self.assert_stopped()

    def test_cli_stop_works_for_a_persistent_background_service(self):
        self.assertFalse(self.start(exit_on_close=False)["exit_on_close"])
        stream = self.session("tab")
        result = subprocess.run([sys.executable, "-m", "easyread", "stop"],
                                cwd=Path(__file__).resolve().parents[1], env=self.env,
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(b"event: shutdown", stream.read())
        self.assert_stopped()


if __name__ == "__main__":
    unittest.main()
