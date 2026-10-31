import json
import unittest
from pathlib import Path
from unittest import mock

from easyread.engines import agent_cli, chat_tools, codebuddy_cli, engines, opencode_cli, zcode_cli


class ChatToolsTest(unittest.TestCase):
    def test_opencode_research_permissions_preserve_default_deny(self):
        with mock.patch.object(opencode_cli.netcheck, "proxy_env", return_value={}):
            normal = opencode_cli.environment()
            research = opencode_cli.environment(chat=True)
        self.assertEqual(json.loads(normal["OPENCODE_PERMISSION"]), {"*": "deny"})
        rules = json.loads(research["OPENCODE_PERMISSION"])
        self.assertEqual(rules, json.loads(research["OPENCODE_CONFIG_CONTENT"])["permission"])
        for tool in ("read", "grep", "websearch", "webfetch"):
            self.assertEqual(rules[tool], "allow")
        for tool in ("bash", "edit", "task", "question"):
            self.assertEqual(rules.get(tool, rules["*"]), "deny")
        self.assertEqual(research["OPENCODE_ENABLE_EXA"], "true")

    def test_codebuddy_and_zcode_research_do_not_enable_writes(self):
        normal = codebuddy_cli.build_args({})
        research = codebuddy_cli.build_args({"_chat": True})
        self.assertEqual(normal[normal.index("--tools") + 1], "")
        self.assertEqual(research[research.index("--tools") + 1], chat_tools.READ_TOOLS)
        normal = zcode_cli.build_args({}, Path("."), [])
        research = zcode_cli.build_args({"_chat": True}, Path("."), [])
        self.assertIn("WebSearch", normal[normal.index("--disallowed-tools") + 1].split())
        denied = research[research.index("--disallowed-tools") + 1].split()
        self.assertNotIn("WebSearch", denied)
        self.assertIn("Bash", denied)
        self.assertIn("Write", denied)
        self.assertNotIn("search the web", research[research.index("--prompt") + 1])

    def test_grok_search_is_chat_only(self):
        normal = agent_cli.build_args("grok", {})
        research = agent_cli.build_args("grok", {"_chat": True})
        self.assertIn("--disable-web-search", normal)
        self.assertNotIn("--disable-web-search", research)
        self.assertEqual(research[research.index("--tools") + 1], "read_file,search_tool")
        self.assertEqual(research[research.index("--disallowed-tools") + 1], "use_tool")

    def test_codex_enables_live_search_without_changing_translation_or_sandbox(self):
        calls = []

        def communicate(proc, prompt, timeout, cancel):
            args = proc
            calls.append(args)
            Path(args[args.index("-o") + 1]).write_text("answer", encoding="utf-8")
            return ""

        with mock.patch.object(engines, "_popen", side_effect=lambda args, cwd: args), \
                mock.patch.object(engines, "_communicate", side_effect=communicate):
            for cfg in ({}, {"_chat": True}):
                engines._codex_once("codex", cfg, "q", Path("."), [], None, [])
        self.assertNotIn('web_search="live"', calls[0])
        self.assertIn('web_search="live"', calls[1])
        self.assertEqual(calls[1][calls[1].index("--sandbox") + 1], "read-only")
