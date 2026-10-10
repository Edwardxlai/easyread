"""检查新版本：版本号比较、一天只问一次、没网不报错、关掉后不联网。  python -m unittest tests.app.test_updates"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread.app import config, updates


class UpdatesTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.patches = [mock.patch.object(config, "HOME", self.home), mock.patch.object(config, "CONFIG_PATH", self.home / "config.json")]
        for p in self.patches:
            p.start()
        self.calls = 0

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def fake(self, tag="v9.0.0", fail=False):
        def fetch():
            self.calls += 1
            if fail:
                raise OSError("没网")
            return {"latest": tag.lstrip("v"), "url": "https://example/r", "notes": "- 新功能", "published": "2026-10-02T00:00:00Z"}
        return mock.patch.object(updates, "_fetch", fetch)

    def test_compare(self):
        self.assertTrue(updates.newer("1.2.10", "1.2.9"))
        self.assertTrue(updates.newer("v1.3.0", "1.2.5"))
        self.assertFalse(updates.newer("1.2.5", "1.2.5"))
        self.assertFalse(updates.newer("1.2.4", "1.2.5"))
        self.assertFalse(updates.newer("", "1.2.5"))

    def test_asks_once_a_day(self):
        with self.fake():
            u = updates.check()
            updates.check()
        self.assertTrue(u["newer"])
        self.assertEqual(u["latest"], "9.0.0")
        self.assertEqual(self.calls, 1)
        with self.fake():
            updates.check(force=True)
        self.assertEqual(self.calls, 2)

    def test_offline_is_quiet(self):
        with self.fake(fail=True):
            u = updates.check()
        self.assertFalse(u["newer"])
        self.assertEqual(self.calls, 1)

    def test_forced_check_offline_reports_failure(self):
        # #54：缓存里是旧版本时手动检查没联上网，不能当成“已经是最新版”
        with self.fake(tag="v0.0.1"):
            self.assertFalse(updates.check()["failed"])
        with self.fake(fail=True):
            u = updates.check(force=True)
        self.assertTrue(u["failed"])
        self.assertEqual(u["latest"], "0.0.1")

    def test_disabled_does_not_ask(self):
        config.save({"check_updates": False})
        with self.fake():
            u = updates.check()
            self.assertEqual(self.calls, 0)
            self.assertFalse(u["enabled"])
            updates.check(force=True)  # 手动检查照样问
        self.assertEqual(self.calls, 1)


if __name__ == "__main__":
    unittest.main()
