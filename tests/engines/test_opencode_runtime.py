"""The reading agent must be discoverable by an already-running CLI service."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.engines import engines, opencode_cli


class OpenCodeRuntimeTest(unittest.TestCase):
    def test_agent_is_on_disk_before_the_cli_starts_and_removed_afterwards(self):
        seen = []

        def start(args, **kwargs):
            root = Path(kwargs["cwd"])
            seen.append(root)
            # A service discovers this directory rather than inheriting env.
            config = json.loads((root / "opencode.json").read_text(encoding="utf-8"))
            agent = (root / ".opencode/agents/easyread-reader.md").read_text(encoding="utf-8")
            self.assertEqual(config["agent"]["easyread-reader"]["permission"], {"*": "deny"})
            self.assertIn("description:", agent)
            self.assertIn("'*': deny", agent)
            self.assertEqual(Path(kwargs["env"]["PWD"]), root.resolve())
            self.assertIn("easyread-reader", args)
            return object()

        with patch.object(opencode_cli, "path", return_value="opencode"), \
             patch.object(opencode_cli.subprocess, "Popen", side_effect=start), \
             patch.object(engines, "_communicate", return_value='{"type":"text","part":{"text":"translated"}}'):
            self.assertEqual(opencode_cli.run({}, "task", Path.cwd(), []), "translated")
        self.assertTrue(seen)
        self.assertFalse(seen[0].exists())

    def test_runtime_does_not_disable_provider_config_or_user_login(self):
        with tempfile.TemporaryDirectory() as folder:
            env = opencode_cli.prepare_runtime(folder)
            config = json.loads((Path(folder) / "opencode.json").read_text(encoding="utf-8"))
            self.assertNotIn("provider", config)
            self.assertNotIn("XDG_CONFIG_HOME", {k: v for k, v in env.items() if k not in opencode_cli.os.environ})
            self.assertEqual(config["permission"], {"*": "deny"})
