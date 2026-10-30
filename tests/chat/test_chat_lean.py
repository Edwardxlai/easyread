"""问答允许只读研究工具，翻译继续精简；保持模型配置与旧版兼容。
python -m unittest tests.chat.test_chat_lean"""
import io
import json
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread.chat import chat
from easyread.engines import engines
from easyread.translate import translate


class FakeProc:
    def __init__(self, lines, err=""):
        self.stdin = io.StringIO()
        self.stdout = iter(lines)
        self.stderr = io.StringIO(err)
        self.returncode = 0

    def poll(self):
        return 0

    def kill(self):
        pass


def result_lines(text):
    return [json.dumps({"type": "stream_event", "event": {"delta": {"type": "text_delta", "text": text}}}) + "\n",
            json.dumps({"type": "result", "subtype": "success", "result": text, "usage": {}}) + "\n"]


class ChatClaudeLeanTest(unittest.TestCase):
    def stream(self, procs, c=None):
        calls = []

        def popen(args, cwd):
            calls.append(list(args))
            return procs[len(calls) - 1]

        with mock.patch.object(engines, "claude_path", lambda c: "claude"), mock.patch.object(engines, "_popen", popen):
            out = "".join(chat._stream_claude(c or {"model": "opus", "reasoning_effort": "high"}, "q", Path("."), threading.Event()))
        return out, calls

    def test_read_search_web_tools_and_user_choices_kept(self):
        out, calls = self.stream([FakeProc(result_lines("答"))])
        self.assertEqual(out, "答")
        a = calls[0]
        self.assertEqual(set(a[a.index("--tools") + 1].split(",")), {"Read", "Glob", "Grep", "WebSearch", "WebFetch"})
        self.assertEqual(a[a.index("--allowedTools") + 1], a[a.index("--tools") + 1])
        self.assertIn("Bash", a[a.index("--disallowedTools") + 1])
        self.assertIn("--strict-mcp-config", a)
        self.assertEqual(a[a.index("--model") + 1], "opus")
        self.assertEqual(a[a.index("--effort") + 1], "high")

    def test_unknown_option_falls_back_before_any_output(self):
        out, calls = self.stream([FakeProc([], err="error: unknown option '--tools'"), FakeProc(result_lines("答"))])
        self.assertEqual(out, "答")
        self.assertIn("--tools", calls[0])
        self.assertNotIn("--tools", calls[1])
        self.assertIn("--disallowedTools", calls[1])

    def test_other_errors_are_not_retried(self):
        with self.assertRaises(engines.EngineError):
            self.stream([FakeProc([], err="network down")])

    def test_cancel_event_untouched_after_answer(self):
        cancel = threading.Event()
        with mock.patch.object(engines, "claude_path", lambda c: "claude"), \
                mock.patch.object(engines, "_popen", lambda a, c: FakeProc(result_lines("答"))):
            "".join(chat._stream_claude({}, "q", Path("."), cancel))
        self.assertFalse(cancel.is_set())  # 重试要用同一个 cancel，答完不能把它置上


class OtherPathsLeanTest(unittest.TestCase):
    def test_codex_chat_answer_and_retranslate_use_lean_cfg(self):
        seen = []

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            seen.append(cfg)
            return '{"zh": "新译文"}'

        cfg = {"engine": "codex", "codex": {"model": "m"}}
        with mock.patch.object(engines, "run", run), mock.patch.object(chat.netcheck, "problem", lambda c: ""):
            list(chat.stream(cfg, "q", Path("."), threading.Event()))
        self.assertTrue(seen[-1]["codex"]["lean"])
        self.assertEqual(seen[-1]["codex"]["model"], "m")
        self.assertTrue(seen[-1]["codex"]["_chat"])
        self.assertNotIn("_chat", cfg["codex"])
        self.assertNotIn("lean", cfg["codex"])

        ws = mock.MagicMock()
        ws.load.return_value = {"notes": {"n1": {"anchor": "p1", "body": "?"}}}
        with mock.patch.object(engines, "run", run), mock.patch.object(translate.prompts, "answer", lambda ws, note: "p"), \
                mock.patch.object(translate, "add_discussion", lambda *a: None):
            translate.answer(ws, cfg, "n1", None)
        self.assertTrue(seen[-1]["codex"]["lean"])
        self.assertNotIn("_chat", seen[-1]["codex"])
        with mock.patch.object(engines, "run", run), mock.patch.object(translate.prompts, "retranslate", lambda ws, k, h: ("p", None)), \
                mock.patch.object(translate, "set_block_text", lambda *a: None):
            translate.retranslate(ws, cfg, "p1", "", None)
        self.assertTrue(seen[-1]["codex"]["lean"])


if __name__ == "__main__":
    unittest.main()
