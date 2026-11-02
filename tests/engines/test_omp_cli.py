"""omp print-mode JSON protocol, arguments, streaming, errors and shared engine wiring."""
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from easyread.app import config
from easyread.chat import chat, chat_models, chat_options
from easyread.engines import engines, omp_cli, usage


def events(*assistant, deltas=()):
    msgs = [{"role": "user", "content": [{"type": "text", "text": "q"}]}, *assistant]
    lines = [{"type": "session"}, {"type": "agent_start"}]
    lines += [{"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "hmm"}}]
    lines += [{"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": d}} for d in deltas]
    lines += [{"type": "message_end", "message": m} for m in msgs]
    lines.append({"type": "agent_end", "messages": msgs})
    return "\n".join(map(json.dumps, lines)) + "\n"


def reply(text, **extra):
    return {"role": "assistant", "content": [{"type": "thinking", "thinking": "hidden"}, {"type": "text", "text": text}],
            "usage": {"input": 10, "output": 3, "cacheRead": 4, "cacheWrite": 2, "totalTokens": 19},
            "stopReason": "stop", **extra}


class FakeProc:
    """stdout replays the given output; hang=True blocks it until the process is killed."""
    def __init__(self, out, code, hang=False):
        self.code, self.returncode, self.killed = code, None, threading.Event()
        self.written = []
        self.stdin = mock.Mock(write=self.written.append, close=lambda: None)
        self.stdout = self._hang() if hang else io.StringIO(out)

    def _hang(self):
        self.killed.wait(5)
        yield from ()

    def poll(self):
        return self.returncode

    def wait(self):
        self.returncode = -9 if self.killed.is_set() else self.code
        return self.returncode

    def kill(self):
        self.killed.set()


class OmpCliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        self.calls = []

    def start(self, out, *, stderr="", code=0, c=None, cancel=None, meter=None, hang=False, fn=None, shown=None):
        def popen(args, **kwargs):
            kwargs["stderr"].write(stderr)
            kwargs["stderr"].flush()
            proc = FakeProc(out, code, hang)
            self.calls.append({"args": args, "proc": proc, **kwargs})
            return proc

        with mock.patch.object(omp_cli, "path", return_value="X:/omp.exe"), \
                mock.patch.object(omp_cli.subprocess, "Popen", side_effect=popen), \
                mock.patch.object(omp_cli.netcheck, "proxy_env", return_value={"HTTPS_PROXY": "http://localhost:7890"}):
            result = (fn or omp_cli.run)(config.DEFAULTS["omp"] | (c or {}), "\u8bba\u6587 prompt", self.cwd,
                                         [Path("page.png")], cancel, meter)
            if fn is not omp_cli.stream:
                return result
            shown = [] if shown is None else shown
            for piece in result:  # consumed while the fake process is installed
                shown.append(piece)
            return shown

    def test_parse_text_usage_and_errors(self):
        text, error, used = omp_cli.parse("noise\n" + events(reply(" PONG ")))
        self.assertEqual((text, error), ("PONG", ""))
        self.assertEqual(used, {"input": 16, "cached": 4, "output": 3})
        # Without agent_end the message_end events are used.
        self.assertEqual(omp_cli.parse(json.dumps({"type": "message_end", "message": reply("partial")}))[0], "partial")
        failed = reply("", stopReason="error", errorMessage="401 unauthorized")
        self.assertEqual(omp_cli.parse(events(failed))[1], "401 unauthorized")
        self.assertEqual(omp_cli.parse(events(reply("", stopReason="aborted")))[1], "aborted")

    def test_args(self):
        args = omp_cli.build_args("omp", {"model": "anthropic/opus", "reasoning_effort": "low", "extra_args": ["--x"]},
                                  [Path("page.png")])
        for flag in ("-p", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-extensions", "--no-lsp", "--no-title"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--mode") + 1], "json")
        self.assertEqual(args[args.index("--model") + 1], "anthropic/opus")
        self.assertEqual(args[args.index("--thinking") + 1], "low")
        self.assertEqual(args[-2:], ["--x", "@" + str(Path("page.png").resolve())])
        plain = omp_cli.build_args("omp", config.DEFAULTS["omp"], [])
        self.assertNotIn("--model", plain)
        self.assertNotIn("--thinking", plain)

    def test_run_prompt_images_usage_and_temp_cwd(self):
        meter = usage.Meter("omp")
        self.assertEqual(self.start(events(reply("translated"), deltas=["trans", "lated"]), meter=meter), "translated")
        call = self.calls[0]
        self.assertEqual(call["proc"].written, ["\u8bba\u6587 prompt"])
        self.assertIn("@" + str((self.cwd / "page.png").resolve()), call["args"])
        self.assertEqual(call["env"]["HTTPS_PROXY"], "http://localhost:7890")
        self.assertNotEqual(Path(call["cwd"]), self.cwd)
        self.assertFalse(Path(call["cwd"]).exists())
        self.assertEqual((meter.data["input"], meter.data["cached"], meter.data["output"]), (16, 4, 3))

    def test_stream_yields_answer_pieces_in_order_and_skips_thinking(self):
        pieces = self.start(events(reply("Hello world"), deltas=["Hel", "lo ", "world"]), fn=omp_cli.stream)
        self.assertEqual(pieces, ["Hel", "lo ", "world"])
        # An omp build that prints no deltas still answers once, from the final message.
        self.assertEqual(self.start(events(reply("whole")), fn=omp_cli.stream), ["whole"])

    def test_stream_error_after_partial_answer_is_raised(self):
        shown = []
        failed = reply("Half", stopReason="error", errorMessage="overloaded")
        with self.assertRaises(engines.EngineError) as caught:
            self.start(events(failed, deltas=["Half"]), fn=omp_cli.stream, shown=shown)
        self.assertEqual(shown, ["Half"])  # the reader saw the partial text, then gets the error
        self.assertIn("overloaded", str(caught.exception))

    def test_failures_surface_stderr(self):
        for out, err, code in [("", 'Model "bogus" not found', 1), (events(reply("partial")), "quota exhausted", 1),
                               (events(reply("", stopReason="error", errorMessage="rejected")), "", 0),
                               (events(), "", 0), ("not json", "", 0)]:
            with self.subTest(out=out), self.assertRaises(engines.EngineError) as caught:
                self.start(out, stderr=err, code=code)
            if err:
                self.assertIn(err, str(caught.exception))

    def test_cancel_and_timeout_end_a_silent_process(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(engines.Cancelled):
            self.start("", cancel=cancel, hang=True)
        self.assertTrue(self.calls[-1]["proc"].killed.is_set())
        began = time.monotonic()
        with self.assertRaises(engines.EngineError) as caught:
            self.start("", c={"timeout": 1}, hang=True)
        self.assertLess(time.monotonic() - began, 4)
        self.assertIn("1", str(caught.exception))
        self.assertTrue(self.calls[-1]["proc"].killed.is_set())

    def test_missing_executable(self):
        with mock.patch.object(omp_cli.shutil, "which", return_value=None), self.assertRaises(engines.EngineError) as caught:
            omp_cli.run(config.DEFAULTS["omp"], "x", self.cwd, [])
        self.assertIn("omp", str(caught.exception))

    def test_detection_translation_and_chat(self):
        with mock.patch.object(omp_cli.shutil, "which", return_value="custom.exe") as which:
            self.assertEqual(engines.cli_path("omp", {"command": ""}), "custom.exe")
            which.assert_called_once_with("omp")
        self.assertEqual(engines.engine_name("omp"), "omp")
        items = chat_models.sanitize([{"id": "o", "name": "omp", "engine": "omp", "model": "opus"}])
        cfg = config.DEFAULTS | {"chat": {"models": items, "default": "o"}}
        ecfg, _ = chat_models.engine_cfg(cfg, "o")
        self.assertEqual(ecfg["omp"]["model"], "opus")
        self.assertEqual(engines.image_mode(ecfg), "attached")
        with mock.patch.object(omp_cli, "run", return_value="answer") as run, \
                mock.patch.object(omp_cli, "stream", return_value=iter(["an", "swer"])) as stream, \
                mock.patch.object(engines.netcheck, "problem", return_value=None):
            self.assertEqual(engines.run(ecfg, "translate", self.cwd), "answer")
            self.assertEqual(list(chat.stream(ecfg, "question", self.cwd, threading.Event())), ["an", "swer"])
            self.assertEqual((run.call_count, stream.call_count), (1, 1))
        self.assertEqual(chat_options.apply(ecfg, {"reasoning_effort": "xhigh"}), {"reasoning_effort": "xhigh"})
        with self.assertRaises(ValueError):
            chat_options.apply(ecfg, {"reasoning_effort": "ultra"})


if __name__ == "__main__":
    unittest.main()
