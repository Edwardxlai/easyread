"""Direct OpenCode calls must not depend on an EasyRead-specific agent."""
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from easyread.engines import engines, opencode_cli


class OpenCodeRuntimeTest(unittest.TestCase):
    def test_prompt_is_sent_directly_without_registering_or_selecting_an_agent(self):
        seen = []

        def start(args, **kwargs):
            root = Path(kwargs["cwd"])
            seen.append(root)
            config = json.loads(kwargs["env"]["OPENCODE_CONFIG_CONTENT"])
            self.assertNotIn("agent", config)
            self.assertEqual(config["permission"], {"*": "deny"})
            self.assertEqual(json.loads(kwargs["env"]["OPENCODE_PERMISSION"]), {"*": "deny"})
            self.assertFalse((root / ".opencode").exists())
            self.assertFalse((root / "opencode.json").exists())
            self.assertEqual(Path(kwargs["env"]["PWD"]), root.resolve())
            self.assertEqual(args, ["opencode", "run", "--format", "json"])
            return Mock(poll=Mock(return_value=0))

        with patch.object(opencode_cli, "path", return_value="opencode"), \
             patch.object(opencode_cli.subprocess, "Popen", side_effect=start), \
             patch.object(engines, "_communicate", return_value='{"type":"text","part":{"text":"translated"}}') as communicate:
            self.assertEqual(opencode_cli.run({}, "task", Path.cwd(), []), "translated")
            self.assertEqual(communicate.call_args.args[1], "task")
        self.assertTrue(seen)
        self.assertFalse(seen[0].exists())

    def test_failed_call_waits_for_process_exit_before_removing_workdir(self):
        seen = []
        proc = Mock(poll=Mock(return_value=None))

        def start(args, **kwargs):
            root = Path(kwargs["cwd"])
            seen.append(root)
            proc.wait.side_effect = lambda: self.assertTrue(root.exists())
            return proc

        with patch.object(opencode_cli, "path", return_value="opencode"), \
             patch.object(opencode_cli.subprocess, "Popen", side_effect=start), \
             patch.object(engines, "_communicate", side_effect=engines.EngineError("timeout")):
            with self.assertRaisesRegex(engines.EngineError, "timeout"):
                opencode_cli.run({}, "task", Path.cwd(), [])
        proc.kill.assert_called_once_with()
        proc.wait.assert_called_once_with()
        self.assertFalse(seen[0].exists())

    def test_runtime_does_not_disable_provider_config_or_user_login(self):
        with patch.dict(opencode_cli.os.environ, {"XDG_CONFIG_HOME": "existing-config"}):
            env = opencode_cli.environment()
            config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
            self.assertNotIn("provider", config)
            self.assertEqual(env["XDG_CONFIG_HOME"], "existing-config")
            self.assertEqual(config["permission"], {"*": "deny"})
