import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread.library import trash


class TrashTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        for name in ("aaaaaaaaaaaa-20261001120000", "bbbbbbbbbbbb-20261001130000"):
            (self.root / ".trash" / name).mkdir(parents=True)

    def test_list_newest_first(self):
        self.assertEqual([t["id"] for t in trash.items(self.root)], ["bbbbbbbbbbbb", "aaaaaaaaaaaa"])

    def test_restore_and_conflict(self):
        self.assertEqual(trash.restore(self.root, "aaaaaaaaaaaa-20261001120000"), "aaaaaaaaaaaa")
        self.assertTrue((self.root / "aaaaaaaaaaaa").is_dir())
        (self.root / "bbbbbbbbbbbb").mkdir()  # 后来又导入过同一篇
        with self.assertRaises(ValueError):
            trash.restore(self.root, "bbbbbbbbbbbb-20261001130000")

    def test_purge_needs_a_valid_name(self):
        for bad in ("", "../x", "aaaaaaaaaaaa"):
            with self.assertRaises(ValueError):
                trash.purge(self.root, bad)
        self.assertEqual(len(trash.items(self.root)), 2)  # 名字不对时什么都没删
        trash.purge(self.root, "aaaaaaaaaaaa-20261001120000")
        self.assertEqual(trash.empty(self.root), 1)
        self.assertEqual(trash.items(self.root), [])

    def test_empty_removes_read_only_files(self):
        f = self.root / ".trash" / "aaaaaaaaaaaa-20261001120000" / "extract" / "fig.png"
        f.parent.mkdir()
        f.write_bytes(b"x")
        os.chmod(f, stat.S_IREAD)
        self.assertEqual(trash.empty(self.root), 2)
        self.assertEqual(trash.items(self.root), [])

    def test_retries_while_sync_holds_files(self):
        # #52：OneDrive 同步时偶尔占住文件，报 WinError 5；稍等再删就能删掉
        real, calls = trash.shutil.rmtree, []

        def flaky(p, **kw):
            calls.append(p)
            if len(calls) == 1:
                raise PermissionError(5, "拒绝访问")
            real(p, **kw)
        with mock.patch.object(trash.shutil, "rmtree", flaky), mock.patch.object(trash.time, "sleep") as sleep:
            trash.purge(self.root, "aaaaaaaaaaaa-20261001120000")
        self.assertEqual(len(calls), 2)
        sleep.assert_called_once()
        self.assertEqual([t["id"] for t in trash.items(self.root)], ["bbbbbbbbbbbb"])

    def test_gives_up_after_retries(self):
        with mock.patch.object(trash.shutil, "rmtree", side_effect=PermissionError(5, "拒绝访问")), mock.patch.object(trash.time, "sleep"):
            with self.assertRaises(PermissionError):
                trash.purge(self.root, "aaaaaaaaaaaa-20261001120000")


if __name__ == "__main__":
    unittest.main()
