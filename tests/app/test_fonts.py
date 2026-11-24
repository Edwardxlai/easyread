import subprocess
import sys
import unittest
from unittest.mock import patch

from easyread.app import fonts


class FontsTest(unittest.TestCase):
    def setUp(self):
        with fonts._lock:
            fonts._cache = None

    def tearDown(self):
        with fonts._lock:
            fonts._cache = None

    def test_clean_filters_internal_dedupes_and_sorts(self):
        got = fonts._clean([
            ".SF NS", "@SimSun", "", "  ", "Maple Mono NF CN",
            "maple mono nf cn", "PingFang SC", "Arial",
        ])
        self.assertEqual(got, ["Arial", "Maple Mono NF CN", "PingFang SC"])

    def test_fc_list_splits_comma_families(self):
        done = subprocess.CompletedProcess([], 0, stdout="Noto Sans SC,Source Han Sans SC\nMaple Mono NF CN\n", stderr="")
        with patch("easyread.app.fonts.shutil.which", return_value="/usr/bin/fc-list"), \
             patch("easyread.app.fonts.subprocess.run", return_value=done):
            got = fonts._clean(fonts._fc_list())
        self.assertEqual(got, ["Maple Mono NF CN", "Noto Sans SC", "Source Han Sans SC"])

    def test_cache_and_fresh_reload(self):
        calls = 0

        def fake_discover():
            nonlocal calls
            calls += 1
            return [f"Font-{calls}"]

        with patch("easyread.app.fonts._discover", side_effect=fake_discover):
            self.assertEqual(fonts.list_families(), ["Font-1"])
            self.assertEqual(fonts.list_families(), ["Font-1"])
            self.assertEqual(calls, 1)
            self.assertEqual(fonts.list_families(fresh=True), ["Font-2"])
            self.assertEqual(calls, 2)

    @unittest.skipUnless(sys.platform == "darwin", "macOS CoreText check")
    def test_darwin_discovers_system_fonts(self):
        got = fonts.list_families(fresh=True)
        self.assertIsInstance(got, list)
        self.assertTrue(len(got) > 0)
        self.assertFalse(any(name.startswith((".", "@")) for name in got))


if __name__ == "__main__":
    unittest.main()
