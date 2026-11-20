import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from easyread.app import config
from easyread.server import server


class FontsApiTest(unittest.TestCase):
    def test_get_fonts_returns_families_and_passes_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_env = os.environ.get("EASYREAD_LIBRARY")
            old_app = getattr(server.Handler, "app", None)
            os.environ["EASYREAD_LIBRARY"] = tmp
            try:
                server.Handler.app = server.App(config.load())
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                threading.Thread(target=httpd.serve_forever, daemon=True).start()
                try:
                    with patch("easyread.app.fonts.list_families", return_value=["Arial", "Maple Mono NF CN"]) as mocked:
                        with urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_address[1]}/api/fonts", timeout=5) as r:
                            self.assertEqual(r.status, 200)
                            self.assertEqual(json.loads(r.read()), {"fonts": ["Arial", "Maple Mono NF CN"]})
                        mocked.assert_called_with(fresh=False)
                        with urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_address[1]}/api/fonts?fresh=1", timeout=5) as r:
                            self.assertEqual(r.status, 200)
                            self.assertEqual(json.loads(r.read()), {"fonts": ["Arial", "Maple Mono NF CN"]})
                        mocked.assert_called_with(fresh=True)
                finally:
                    httpd.shutdown()
                    httpd.server_close()
            finally:
                server.Handler.app = old_app
                if old_env is None:
                    os.environ.pop("EASYREAD_LIBRARY", None)
                else:
                    os.environ["EASYREAD_LIBRARY"] = old_env


if __name__ == "__main__":
    unittest.main()
