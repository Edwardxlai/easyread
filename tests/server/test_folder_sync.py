import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from easyread.bulk.folder_sync import FolderSync
from easyread.library.library import Library
from easyread.server.library_api import LibraryLocation
from easyread.server.server import Handler


class FolderSyncHTTPTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        local_home = patch("easyread.bulk.folder_sync.config.HOME", self.root / "profile")
        local_home.start()
        self.addCleanup(local_home.stop)
        self.watch = self.root / "Downloads"
        self.watch.mkdir()
        self.app = SimpleNamespace(lib=Library(self.root / "library"), token="fixture-token")
        self.app.location = LibraryLocation(self.app)
        self.app.folder_sync = FolderSync(self.app)

        class FixtureHandler(Handler):
            app = self.app

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_port
        self.body = {"action": "set_default", "path": str(self.watch), "enabled": True}

    def request(self, method="GET", headers=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, "/api/folder-sync", json.dumps(self.body) if method == "POST" else None,
                               headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_cross_origin_and_rebound_hosts_cannot_read_or_change_mappings(self):
        for method in ("GET", "POST"):
            for headers in ({"Origin": "https://example.invalid"}, {"Origin": "null"},
                            {"Host": f"example.invalid:{self.port}"}):
                with self.subTest(method=method, headers=headers):
                    status, _ = self.request(method, {"X-Token": self.app.token, **headers})
                    self.assertEqual(status, 403)
                    self.assertFalse(self.app.folder_sync.path.exists())

    def test_writes_require_token_and_respect_library_migration_gate(self):
        self.assertEqual(self.request("POST")[0], 403)
        headers = {"X-Token": self.app.token, "Origin": f"http://127.0.0.1:{self.port}"}
        self.app.location.status = "moving"
        self.assertEqual(self.request("POST", headers)[0], 400)
        self.assertFalse(self.app.folder_sync.path.exists())
        self.app.location.status = "idle"
        status, response = self.request("POST", headers)
        self.assertEqual(status, 200)
        self.assertEqual(response["default"]["path"], str(self.watch))
        self.assertFalse(response["default"]["translate"])
        self.assertFalse(response["default"]["network_metadata"])
