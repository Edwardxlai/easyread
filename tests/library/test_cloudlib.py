import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from easyread.library import cloudlib, cloudlib_detect, paper_labels
from easyread.app import config
from easyread.library.cloudlib_lock import LibraryMarker
from easyread.library.library import Library
from easyread.server.library_api import LibraryLocation
from easyread.library.store import write_json_atomic


def paper(root, pid, pdf=None):
    folder = root / pid
    folder.mkdir(parents=True)
    write_json_atomic(folder / "item.json", {"tags": ["test"]})
    write_json_atomic(folder / "paper.json", {"meta": {}})
    write_json_atomic(folder / "reader.json", {"notes": {"note": "preserve me"}})
    (folder / "source.pdf").write_bytes(pdf or b"%PDF " + pid.encode())
    return folder


class CloudLibraryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()  # macOS 的 /var 是软链接、Windows CI 是 RUNNER~1 短路径；代码比较的是解析后的路径
        self.src, self.dst = self.root / "source", self.root / "EasyRead"
        self.src.mkdir()
        for key, value in (("CONFIG_PATH", self.root / "config.json"),):
            cm = patch.object(config, key, value)
            cm.start(); self.addCleanup(cm.stop)
        cm = patch.dict(os.environ, {})
        cm.start(); self.addCleanup(cm.stop)
        cm = patch("easyread.library.cloudlib.detect", return_value=[])
        cm.start(); self.addCleanup(cm.stop)
        for name in ("EASYREAD_LIBRARY", "COREAD_LIBRARY", "OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
            os.environ.pop(name, None)
        config.save({"library_dir": str(self.src)})
        self.app = SimpleNamespace(lib=Library(self.src), jobs=SimpleNamespace(busy=lambda: False), presence=None)
        self.location = LibraryLocation(self.app)

    def migrate(self, mode="copy", target=None):
        return self.location.move({"path": str(target or self.dst), "mode": mode})

    @unittest.skipUnless(os.name == "nt", "Windows drive roots")
    def test_missing_drive_returns_in_a_second_and_reopens_gate(self):
        missing = next((Path(f"{letter}:/") for letter in "QZYXWVUTSR" if not Path(f"{letter}:/").exists()), None)
        if missing is None:
            self.skipTest("No unused drive letter available")
        # 子进程给旧实现设硬超时，回归时不会把整个测试进程卡在根目录循环里。
        script = """
import json, sys, time
from pathlib import Path
from types import SimpleNamespace
from easyread.library import cloudlib
from easyread.app import config
from easyread.library.library import Library
from easyread.server.library_api import LibraryLocation
config.CONFIG_PATH = Path(sys.argv[1])
source, target = Path(sys.argv[2]), sys.argv[3]
location = LibraryLocation(SimpleNamespace(lib=Library(source), jobs=SimpleNamespace(busy=lambda: False), presence=None))
errors, times = [], []
for operation in (lambda: cloudlib.inspect(target), lambda: location.move({"path": target, "mode": "copy"})):
    start = time.monotonic()
    try:
        operation()
    except ValueError as error:
        errors.append(str(error))
    times.append(time.monotonic() - start)
print(json.dumps({"errors": errors, "times": times, "status": location.status, "path": config.load()["library_dir"]}))
"""
        result = subprocess.run([sys.executable, "-c", script, str(config.CONFIG_PATH), str(self.src),
                                 str(missing / "nope" / "EasyRead")],
                                capture_output=True, text=True, encoding="utf-8", timeout=2, check=True)
        data = json.loads(result.stdout)
        self.assertEqual(len(data["errors"]), 2)
        self.assertTrue(all(elapsed < 1 for elapsed in data["times"]))
        self.assertEqual(data["status"], "idle")
        self.assertEqual(data["path"], str(self.src))

    def test_copy_preserves_all_papers_notes_trash_and_old_library(self):
        for pid in ("paper001", "paper002", "paper003"):
            paper(self.src, pid)
        paper(self.src / ".trash", "deleted01")
        paper_labels.create(self.src, "Reusable tag")
        paper_labels.edit(self.src, Library(self.src).ws("paper001"), {"add": ["Applied tag"]})
        result = self.migrate()
        self.assertEqual(result["copied"], 3)
        self.assertEqual(config.load()["library_dir"], str(self.dst))
        self.assertEqual(self.location.status, "restart_required")
        for original in self.src.rglob("*"):
            if original.is_file():
                self.assertEqual(original.read_bytes(), (self.dst / original.relative_to(self.src)).read_bytes())

    def test_failed_copy_does_not_change_configuration_or_existing_files(self):
        paper(self.src, "paper001")
        self.dst.mkdir()
        (self.dst / "keep.txt").write_text("original")
        with patch("easyread.library.cloudlib.shutil.copy2", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.migrate()
        self.assertEqual(config.load()["library_dir"], str(self.src))
        self.assertEqual(self.location.status, "idle")
        self.assertEqual((self.dst / "keep.txt").read_text(), "original")
        self.assertFalse(list(self.dst.glob(".easyread-copy-*")))

    def fail_second_publication(self):
        rename = Path.rename

        def locked(path, target):
            if Path(target).parent == self.dst / "paper002":
                raise OSError("second paper is locked")
            return rename(path, target)
        return patch.object(Path, "rename", locked)

    def test_failed_second_publication_rolls_back_new_papers(self):
        for pid in ("paper001", "paper002"):
            paper(self.src, pid)
        self.dst.mkdir()
        (self.dst / "keep.txt").write_text("original")
        with self.fail_second_publication(), self.assertRaisesRegex(OSError, "second paper"):
            self.migrate()
        self.assertEqual(cloudlib.inspect(self.dst)["papers"], 0)
        self.assertEqual((self.dst / "keep.txt").read_text(), "original")
        self.assertEqual(config.load()["library_dir"], str(self.src))
        self.assertEqual(self.location.status, "idle")
        self.assertEqual(cloudlib.inspect(self.src, exact=True)["papers"], 2)
        self.assertTrue(all((self.src / pid / "reader.json").is_file() for pid in ("paper001", "paper002")))

    def test_failed_merge_keeps_existing_target_and_rolls_back_additions(self):
        for pid in ("paper001", "paper002"):
            paper(self.src, pid)
        existing = paper(self.dst, "existing")
        before = {p.name: p.read_bytes() for p in existing.iterdir()}
        with self.fail_second_publication(), self.assertRaisesRegex(OSError, "second paper"):
            self.migrate("merge")
        self.assertEqual(cloudlib.inspect(self.dst)["papers"], 1)
        self.assertEqual({p.name: p.read_bytes() for p in existing.iterdir()}, before)
        self.assertFalse((self.dst / "paper001").exists())
        self.assertFalse((self.dst / "paper002").exists())
        self.assertEqual(config.load()["library_dir"], str(self.src))

    def test_locked_rollback_leaves_marker_and_blocks_partial_library_use(self):
        for pid in ("paper001", "paper002"):
            paper(self.src, pid)
        paper(self.dst, "existing")
        remove = cloudlib.shutil.rmtree

        def locked(path, *args, **kwargs):
            if Path(path) == self.dst / "paper001":
                raise PermissionError("sync client locks rollback")
            return remove(path, *args, **kwargs)
        with self.fail_second_publication(), patch("easyread.library.cloudlib.shutil.rmtree", side_effect=locked), \
                self.assertRaises(OSError):
            self.migrate("merge")
        with self.assertRaisesRegex(ValueError, "未完成"):
            cloudlib.inspect(self.dst)
        for mode in ("use", "merge", "copy"):
            with self.assertRaisesRegex(ValueError, "未完成"):
                self.migrate(mode)
        self.assertEqual(config.load()["library_dir"], str(self.src))
        self.assertEqual(self.location.status, "idle")

    def assert_successful_switch_is_read_only(self, result):
        self.assertTrue(result["ok"])
        self.assertTrue(result["restart_required"])
        self.assertEqual(config.load()["library_dir"], str(self.dst))
        self.assertEqual(self.location.status, "restart_required")
        self.assertTrue(result["warnings"])
        with self.assertRaises(ValueError), self.location.request("POST", "/api/p/paper001/ops"):
            pass
        self.assertEqual(cloudlib.inspect(self.dst)["papers"], 1)

    def test_staging_cleanup_error_reports_success_and_keeps_old_library_read_only(self):
        paper(self.src, "paper001")
        with patch("easyread.library.cloudlib.shutil.rmtree", side_effect=OSError("sync client locks cleanup")), \
                self.assertLogs("easyread", level="WARNING"):
            result = self.migrate()
        self.assert_successful_switch_is_read_only(result)
        self.assertIn("临时目录", result["message"])

    def test_marker_cleanup_error_reports_success_and_new_library_can_open(self):
        paper(self.src, "paper001")
        unlink = Path.unlink

        def locked(path, *args, **kwargs):
            if path.name == cloudlib.MIGRATION_MARKER:
                raise PermissionError("sync client locks marker")
            return unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", locked), self.assertLogs("easyread", level="WARNING"):
            result = self.migrate()
        self.assert_successful_switch_is_read_only(result)
        reopened = LibraryLocation(SimpleNamespace(lib=Library(self.dst), jobs=self.app.jobs, presence=None))
        self.assertEqual(reopened.location()["papers"], 1)

    def test_configuration_failure_rolls_back_before_reusing_target(self):
        paper(self.src, "paper001")
        with patch("easyread.library.cloudlib.config.save", side_effect=OSError("configuration is locked")), \
                self.assertRaisesRegex(OSError, "configuration"):
            self.migrate()
        self.assertEqual(cloudlib.inspect(self.dst)["papers"], 0)
        self.assertEqual(config.load()["library_dir"], str(self.src))
        self.assertEqual(self.location.status, "idle")

    def test_locked_rollback_marker_preserves_complete_ready_target(self):
        paper(self.src, "paper001")
        write = cloudlib.write_json_atomic

        def locked(path, value):
            if value.get("state") == "rollback":
                raise OSError("rollback marker is locked")
            return write(path, value)
        with patch("easyread.library.cloudlib.write_json_atomic", side_effect=locked), \
                patch("easyread.library.cloudlib.config.save", side_effect=OSError("configuration is locked")), \
                self.assertLogs("easyread", level="ERROR"), self.assertRaises(OSError):
            self.migrate()
        self.assertEqual(cloudlib.inspect(self.dst)["papers"], 1)
        self.assertEqual(config.load()["library_dir"], str(self.src))
        self.assertEqual(self.location.status, "idle")

    def test_mismatch_is_not_accepted(self):
        paper(self.src, "paper001")
        with patch("easyread.library.cloudlib.shutil.copy2", side_effect=lambda s, d: Path(d).write_bytes(b"bad")):
            with self.assertRaisesRegex(ValueError, "核对失败"):
                self.migrate()
        self.assertEqual(config.load()["library_dir"], str(self.src))

    def test_merge_full_pdf_sha_and_id_collision_keep_target(self):
        paper(self.src, "paper001", b"%PDF same")
        paper(self.src, "paper002")
        paper(self.src, "paper003")
        paper(self.dst, "differentid", b"%PDF same")
        target = paper(self.dst, "paper003", b"%PDF other")
        result = self.migrate("merge")
        self.assertEqual(result["copied"], 1)
        self.assertEqual(len(result["skipped"]), 2)
        self.assertEqual((target / "source.pdf").read_bytes(), b"%PDF other")
        self.assertTrue((self.dst / "paper002").is_dir())

    def test_use_does_not_copy_or_remove_source(self):
        paper(self.src, "paper001")
        paper(self.dst, "paper002")
        result = self.migrate("use")
        self.assertEqual(result["copied"], 0)
        self.assertFalse((self.dst / "paper001").exists())
        self.assertTrue((self.src / "paper001").exists())

    def test_nested_paths_and_temporary_library_rejected(self):
        for dst in (self.src, self.src / "nested", self.src.parent):
            with self.assertRaisesRegex(ValueError, "不能"):
                self.migrate(target=dst)
        with patch.dict(os.environ, {"EASYREAD_LIBRARY": str(self.src)}):
            with self.assertRaisesRegex(ValueError, "临时"):
                self.migrate()

    def test_unknown_target_with_same_id_never_overwritten(self):
        paper(self.src, "paper001")
        self.dst.mkdir()
        (self.dst / "paper001").write_text("unknown")
        with self.assertRaisesRegex(ValueError, "不会覆盖"):
            self.migrate()
        self.assertEqual((self.dst / "paper001").read_text(), "unknown")

    def test_busy_job_and_dequeued_job_transition_rejected(self):
        self.app.jobs.busy = lambda: True
        with self.assertRaisesRegex(ValueError, "任务"):
            self.migrate()
        self.app.jobs.busy = lambda: False
        folder = paper(self.src, "paper001")
        write_json_atomic(folder / "job.json", {"state": "queued"})
        with self.assertRaisesRegex(ValueError, "任务"):
            self.migrate()

    def test_requests_warm_and_other_pages_block_migration(self):
        with self.location.request("POST", "/api/p/paper001/chat"):
            with self.assertRaisesRegex(ValueError, "保存"):
                self.migrate()
        self.location.begin()
        with self.assertRaisesRegex(ValueError, "保存"):
            self.migrate()
        self.location.end()
        self.app.presence = SimpleNamespace(pages=2, lock=threading.Lock())
        with self.assertRaisesRegex(ValueError, "关闭其他"):
            self.migrate()

    def test_gate_freezes_writes_during_copy_and_until_restart(self):
        paper(self.src, "paper001")
        copy = cloudlib._copy_verified

        def guarded(src, dst):
            self.assertEqual(self.location.status, "moving")
            with self.assertRaises(ValueError), self.location.request("POST", "/api/p/paper001/ops"):
                pass
            with self.assertRaises(ValueError), self.location.request("GET", "/read/paper001"):
                pass
            return copy(src, dst)
        with patch("easyread.library.cloudlib._copy_verified", side_effect=guarded):
            self.migrate()
        with self.assertRaises(ValueError), self.location.request("POST", "/api/import"):
            pass
        with self.location.request("GET", "/api/p/paper001/state"):
            pass

    def test_links_and_junctions_cannot_escape_source(self):
        folder = paper(self.src, "paper001")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("never copy")
        link = folder / "escape"
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            with self.assertRaisesRegex(ValueError, "链接|联接"):
                self.migrate()
            self.assertEqual(config.load()["library_dir"], str(self.src))
            self.assertEqual((outside / "secret.txt").read_text(), "never copy")
        finally:
            # 只移除链接本身；Windows rmdir 不递归，不删除链接目标。
            if os.name == "nt":
                link.rmdir()
            else:
                link.unlink()

    def test_detection_uses_existing_onedrive_and_subfolder(self):
        disk = self.root / "OneDrive"
        disk.mkdir()
        with patch.dict(os.environ, {"OneDrive": str(disk), "OneDriveCommercial": str(self.root / "missing")}), \
                patch("easyread.library.cloudlib_detect.Path.home", return_value=self.root):
            candidates = cloudlib_detect.detect()
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]["path"], str(disk / "EasyRead"))
            self.assertEqual(cloudlib.inspect(disk)["path"], str(disk / "EasyRead"))
            self.assertFalse((disk / "EasyRead").exists())

    def test_marker_recent_other_host_and_owned_cleanup(self):
        marker = LibraryMarker(self.src)
        for minutes, expected in ((2, "other-pc"), (10, "")):
            write_json_atomic(marker.path, {"host": "other-pc", "pid": 123,
                "at": (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()})
            self.assertEqual(marker.other_device(), expected)
        marker.refresh()
        marker.close()
        self.assertFalse(marker.path.exists())
        write_json_atomic(marker.path, {"owner": "someone-else"})
        marker.close()
        self.assertTrue(marker.path.exists())

    def test_get_cannot_invoke_mutating_library_routes(self):
        from easyread.server.server import Handler
        self.app.location = self.location
        handler = Handler.__new__(Handler)
        handler.app = self.app
        handler._json = Mock()
        for path in ("/api/library/move", "/api/shutdown", "/api/library/reveal"):
            handler.path = path
            with patch("easyread.server.library_api.post") as post:
                handler._get()
                post.assert_not_called()
                self.assertEqual(handler._json.call_args.args[0], 404)


if __name__ == "__main__":
    unittest.main()


class MarkerRecoveryTest(unittest.TestCase):
    """第二轮审查：不可写目录不能卡死；本机没搬完的目标能清理；别的电脑的标记不拦。"""

    setUp = CloudLibraryTest.setUp
    migrate = CloudLibraryTest.migrate
    fail_second_publication = CloudLibraryTest.fail_second_publication

    def test_unwritable_folder_returns_immediately(self):
        self.dst.mkdir()
        with patch("easyread.library.cloudlib.os.open", side_effect=PermissionError("denied")), \
                patch("easyread.library.cloudlib.uuid.uuid4", wraps=cloudlib.uuid.uuid4) as probe:
            self.assertFalse(cloudlib.inspect(self.dst)["writable"])
        self.assertEqual(probe.call_count, 1)  # 只试一次，不像 tempfile 那样重试
        paper(self.src, "paper001")
        with patch("easyread.library.cloudlib.os.open", side_effect=PermissionError("denied")), \
                self.assertRaisesRegex(ValueError, "不可写"):
            self.migrate()
        self.assertEqual(self.location.status, "idle")

    def locked_merge(self):
        for pid in ("paper001", "paper002"):
            paper(self.src, pid)
        existing = paper(self.dst, "existing")
        remove = cloudlib.shutil.rmtree

        def locked(path, *args, **kwargs):
            if Path(path) == self.dst / "paper001":
                raise PermissionError("sync client locks rollback")
            return remove(path, *args, **kwargs)
        with self.fail_second_publication(), patch("easyread.library.cloudlib.shutil.rmtree", side_effect=locked), \
                self.assertRaises(OSError):
            self.migrate("merge")
        return existing

    def test_cleanup_restores_target_and_unblocks(self):
        existing = self.locked_merge()
        info = self.location.location()  # 候选里有没搬完的目标也不能抛错
        self.assertIn("papers", info)
        from easyread.server import library_api
        self.assertTrue(library_api.inspect({"path": str(self.dst)})["incomplete"])
        result = cloudlib.cleanup(self.dst, self.src)
        self.assertTrue(result["ok"])
        self.assertEqual(sorted(p.name for p in self.dst.iterdir()), ["existing"])
        self.assertTrue((existing / "reader.json").exists())
        self.assertEqual(cloudlib.inspect(self.dst)["papers"], 1)
        self.assertEqual(sorted(p.name for p in self.src.iterdir()), ["paper001", "paper002"])

    def test_cleanup_refuses_current_library(self):
        self.locked_merge()
        with self.assertRaises(ValueError):
            cloudlib.cleanup(self.dst, self.dst)

    def test_marker_from_another_computer_does_not_block(self):
        self.locked_merge()
        with patch("easyread.library.cloudlib.socket.gethostname", return_value="OTHER-PC"):
            self.assertEqual(cloudlib.inspect(self.dst)["papers"], 2)

    def test_ready_marker_opens_from_another_path(self):
        paper(self.dst, "paper001")
        write_json_atomic(self.dst / cloudlib.MIGRATION_MARKER, {"state": "ready", "target": "D:/elsewhere/EasyRead"})
        self.assertEqual(cloudlib.inspect(self.dst)["papers"], 1)
        self.migrate("use")
        self.assertFalse((self.dst / cloudlib.MIGRATION_MARKER).exists())
