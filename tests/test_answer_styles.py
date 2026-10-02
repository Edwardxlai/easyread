"""回答方式从 HTTP 请求、提示词、流式输出一直保留到对话和页边笔记。"""
import json
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from easyread import chat, chat_store
from easyread.server import Handler
from easyread.store import Workspace, write_json_atomic

ANSWER = "## 结果\n误差为 2%。器件计算 $y=Wx$。\n\n## 局限\n测试采用室温和固定权重。"
BILINGUAL_ANSWER = ("## 中文回答\n室温下，误差为 2%。器件计算 $y=Wx$。\n\n"
                    "## 英文回答\nAt room temperature, the error is 2%. The device calculates $y=Wx$.")


class AnswerStyleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        write_json_atomic(self.ws.paper_path, {"meta": {"title_en": "Test paper"}, "blocks": [
            {"id": "a", "type": "para", "page": 1, "role": "abstract", "en": "An abstract.", "zh": "摘要"},
            {"id": "b", "type": "para", "page": 2, "en": "A source fact with $x$.", "zh": "当前段落"},
            {"id": "list", "type": "list", "page": 3, "items": [{"en": "A test condition.", "zh": "测试条件"}]},
            {"id": "table", "type": "table", "page": 4, "caption_en": "Test results", "head": [["Error"]], "rows": [["2%"]]},
            {"id": "eq", "type": "math", "page": 5, "tex": "y=2x"},
            {"id": "c", "type": "para", "page": 6, "en": "A final limitation.", "zh": "局限"},
        ]})

    def test_prompt_switches_language_without_losing_source_or_history(self):
        messages = [{"role": "assistant", "content": "Previous answer in English."}, {"role": "user", "content": "总结论文"}]
        for engine in ("openai", "claude", "codex"):
            with self.subTest(engine=engine):
                normal = chat.prompt(self.ws, messages, "b", "引用", engine)
                ste = chat.prompt(self.ws, messages, "b", "引用", engine, answer_style="ste100")
                self.assertIn("用中文，直接", normal)
                self.assertNotIn("本次使用 ASD-STE100", normal)
                self.assertNotIn("当前已导入的正文", normal)
                self.assertNotIn("A final limitation.", normal)
                self.assertNotIn("用中文，直接", ste)
                self.assertIn("只输出中文回答，不附英文答案", ste)
                self.assertNotIn("## English (ASD-STE100)", ste)
                for fact in ("Previous answer in English.", "A source fact with $x$.", "引用", "A test condition.", "2%", "$$y=2x$$", "A final limitation."):
                    self.assertIn(fact, ste)
                self.assertIn("每句表达一个主要意思", ste)
                self.assertIn("不要把英文的词数限制机械地套到中文", ste)
                self.assertIn("不要声称", ste)

    def test_ste_context_only_includes_annotations_when_the_question_requests_them(self):
        write_json_atomic(self.ws.root / "reader.json", {"notes": {
            "r": {"anchor": "b", "quote": "red selection", "body": "red private note", "color": "pink"},
            "b": {"anchor": "c", "quote": "blue selection", "body": "blue private note", "color": "blue"},
        }})
        for style in ("standard", "ste100", "ste100_bilingual"):
            with self.subTest(style=style):
                plain = chat.prompt(self.ws, [{"role": "user", "content": "总结论文"}], "b", "", "openai", answer_style=style)
                self.assertNotIn("red private note", plain)
                self.assertNotIn("blue private note", plain)
                red = chat.prompt(self.ws, [{"role": "user", "content": "我标红的那些有什么联系"}], "b", "", "openai", answer_style=style)
                self.assertIn("red private note", red)
                self.assertNotIn("blue private note", red)

    def test_all_modes_and_engines_require_renderable_math_output(self):
        for engine in ("openai", "claude", "codex"):
            for style in ("standard", "ste100", "ste100_bilingual"):
                with self.subTest(engine=engine, style=style):
                    prompt = chat.prompt(self.ws, [{"role": "user", "content": "推导这个公式"}], "eq", "", engine, answer_style=style)
                    self.assertIn("行内公式只用 $TeX$", prompt)
                    self.assertIn("行间公式只用 $$TeX$$", prompt)
                    self.assertIn("不要用 \\(\\) 或 \\[\\]", prompt)
                    self.assertIn("不要把公式放进反引号或代码块", prompt)
                    self.assertIn("不要在公式中插入空行", prompt)

    def test_bilingual_prompt_uses_chinese_then_equivalent_english_for_each_engine(self):
        messages = [{"role": "assistant", "content": "Previously only Chinese."},
                    {"role": "user", "content": "总结论文"}]
        for engine in ("openai", "claude", "codex"):
            with self.subTest(engine=engine):
                prompt = chat.prompt(self.ws, messages, "b", "引用", engine, answer_style="ste100_bilingual")
                self.assertIn("本次开启中英文对照", prompt)
                self.assertLess(prompt.index("## 中文回答"), prompt.index("## 英文回答"))
                self.assertIn("两个版本必须表达相同内容", prompt)
                self.assertIn("数值、单位、公式、实验条件、范围", prompt)
                self.assertIn("技术名词保留论文中的准确用词", prompt)
                self.assertIn("不要在其中一个版本独立添加结论", prompt)
                self.assertNotIn("只输出中文回答", prompt)
                self.assertNotIn("用中文，直接", prompt)
                for fact in ("Previously only Chinese.", "引用", "A source fact with $x$.",
                             "A test condition.", "2%", "$$y=2x$$", "A final limitation."):
                    self.assertIn(fact, prompt)

    def test_ste_prompt_preserves_source_conditions_and_requirement_strength(self):
        source = "At room temperature, this design may reduce loss. Only some devices were tested. The operator should check the sample. Use no more than 5 V."
        self.ws.update("paper", lambda p: p.update(blocks=[{"id": "p1", "type": "para", "page": 1, "en": source}]))
        for engine in ("openai", "claude", "codex"):
            with self.subTest(engine=engine):
                prompt = chat.prompt(self.ws, [{"role": "user", "content": "所有器件都能降低损耗吗？"}], None, "", engine, answer_style="ste100")
                self.assertIn(source, prompt)
                self.assertIn('“可能”不能改成“确定”', prompt)
                self.assertIn('“建议”不能改成“必须”', prompt)
                self.assertIn('“部分”不能改成“全部”', prompt)
                self.assertIn("准确性优先于简短", prompt)
                self.assertIn("不补造原文未说明", prompt)

    def test_long_paper_excerpt_is_bounded_and_keeps_late_results(self):
        blocks = [{"id": f"p{i}", "type": "para", "page": i + 1,
                   "en": f"Start{i}. " + "middle " * 2000 + f" Final{i}."} for i in range(50)]
        self.ws.update("paper", lambda p: p.update(blocks=blocks))
        excerpt = chat._paper_context(self.ws)
        self.assertIn("正文节选", excerpt)
        self.assertIn("不能视为已读", excerpt)
        self.assertIn("Start0.", excerpt)
        self.assertIn("Final49.", excerpt)
        self.assertLessEqual(len(excerpt.split("：\n\n", 1)[1]), chat.PAPER_BUDGET)

    def test_legacy_messages_do_not_inherit_later_ste_badges(self):
        write_json_atomic(self.ws.root / "chat.json", {"messages": [
            {"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"},
        ]})
        chat_store.append(self.ws, "t-first", {"content": "新问题", "answer_style": "ste100"}, ANSWER, "m", "Model")
        saved = chat_store.get(self.ws, "t-first")
        self.assertEqual(saved["answer_style"], "ste100")
        self.assertEqual([m["answer_style"] for m in saved["messages"]], ["standard", "standard", "ste100", "ste100"])

    def test_partially_imported_paper_identifies_missing_pages(self):
        self.ws.update("paper", lambda p: p.update(meta={"page_count": 12}, translation={"done_pages": [1, 2]}))
        text = chat._paper_context(self.ws)
        self.assertIn("只完成整理 2 / 12 页", text)

    def test_note_question_reply_keeps_chinese_answer_and_formula(self):
        write_json_atomic(self.ws.root / "reader.json", {"notes": {"n1": {"id": "n1", "anchor": "b", "kind": "question", "body": "explain"}}})
        chat_store.append(self.ws, "t-note", {"content": "explain", "note": "n1", "answer_style": "ste100"}, ANSWER, "m", "Model")
        entry = self.ws.load("discussion")["entries"][0]
        self.assertEqual(entry["reply_to"], "n1")
        self.assertEqual(entry["body"], ANSWER)

    def start_server(self):
        ws = self.ws

        class TestHandler(Handler):
            app = types.SimpleNamespace(token="test-token", lib=types.SimpleNamespace(ws=lambda pid: ws))

            def log_message(self, *args):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        self.url = f"http://127.0.0.1:{srv.server_port}/api/p/test/chat"

    def post(self, body):
        req = urllib.request.Request(self.url, json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "X-Token": "test-token"})
        with urllib.request.urlopen(req, timeout=5) as res:
            self.assertEqual(res.headers.get_content_type(), "application/x-ndjson")
            return [json.loads(line) for line in res.read().decode().splitlines()]

    def test_stream_and_followup_remember_mode_and_pin_complete_answer(self):
        self.start_server()
        engine = {"engine": "openai"}
        model = {"id": "m", "name": "Model", "engine": "openai", "model": "test"}
        with patch("easyread.server.config.load", return_value={}), \
                patch("easyread.server.chat_models.engine_cfg", return_value=(engine, model)), \
                patch("easyread.server.chat.stream", side_effect=lambda *a: iter([ANSWER[:35], ANSWER[35:]])) as stream:
            events = self.post({"text": "总结论文", "anchor": "b", "answer_style": "ste100"})
            tid = events[0]["thread"]
            self.assertEqual(events[0]["answer_style"], "ste100")
            self.assertEqual("".join(e.get("t", "") for e in events), ANSWER)
            saved = chat_store.get(self.ws, tid)
            self.assertEqual(saved["answer_style"], "ste100")
            self.assertEqual(saved["messages"][-1]["content"], ANSWER)
            chat_store.pin(self.ws, tid, events[-1]["id"])
            self.assertEqual(self.ws.load("discussion")["entries"][0]["body"], ANSWER)
            inherited = self.post({"thread": tid, "text": "再解释一下"})
            self.assertEqual(inherited[0]["answer_style"], "ste100")
            self.assertIn("本次使用 ASD-STE100", stream.call_args.args[1])
            standard = self.post({"thread": tid, "text": "普通解释", "answer_style": "standard"})
            self.assertEqual(standard[0]["answer_style"], "standard")
            self.assertNotIn("本次使用 ASD-STE100", stream.call_args.args[1])
            saved = chat_store.get(self.ws, tid)
            self.assertEqual(saved["answer_style"], "standard")
            self.assertEqual(saved["messages"][1]["answer_style"], "ste100")

    def test_bilingual_mode_survives_followup_switch_and_pin_without_rewriting_history(self):
        self.start_server()
        engine = {"engine": "openai"}
        model = {"id": "m", "name": "Model", "engine": "openai", "model": "test"}
        with patch("easyread.server.config.load", return_value={}), \
             patch("easyread.server.chat_models.engine_cfg", return_value=(engine, model)), \
             patch("easyread.server.chat.stream", return_value=iter([BILINGUAL_ANSWER])) as stream:
            events = self.post({"text": "中英总结论文", "anchor": "b", "answer_style": "ste100_bilingual"})
            tid = events[0]["thread"]
            self.assertEqual(events[0]["answer_style"], "ste100_bilingual")
            saved = chat_store.get(self.ws, tid)
            self.assertEqual(saved["answer_style"], "ste100_bilingual")
            self.assertEqual([m["answer_style"] for m in saved["messages"]], ["ste100_bilingual"] * 2)
            self.assertEqual(saved["messages"][1]["content"], BILINGUAL_ANSWER)
            chat_store.pin(self.ws, tid, events[-1]["id"])
            self.assertEqual(self.ws.load("discussion")["entries"][0]["body"], BILINGUAL_ANSWER)
            stream.return_value = iter([BILINGUAL_ANSWER])
            inherited = self.post({"thread": tid, "text": "再解释一下"})
            self.assertEqual(inherited[0]["answer_style"], "ste100_bilingual")
            self.assertIn("本次开启中英文对照", stream.call_args.args[1])
            stream.return_value = iter([ANSWER])
            chinese = self.post({"thread": tid, "text": "仅中文解释", "answer_style": "ste100"})
            self.assertEqual(chinese[0]["answer_style"], "ste100")
            self.assertIn("只输出中文回答", stream.call_args.args[1])
            self.assertNotIn("本次开启中英文对照", stream.call_args.args[1])
            saved = chat_store.get(self.ws, tid)
            self.assertEqual(saved["answer_style"], "ste100")
            self.assertEqual(saved["messages"][1]["content"], BILINGUAL_ANSWER)
            self.assertEqual(saved["messages"][1]["answer_style"], "ste100_bilingual")
            self.assertEqual(saved["messages"][-1]["answer_style"], "ste100")

    def test_bilingual_note_reply_preserves_both_languages_and_formulas(self):
        write_json_atomic(self.ws.root / "reader.json", {"notes": {
            "n1": {"id": "n1", "anchor": "b", "kind": "question", "body": "解释"},
        }})
        chat_store.append(self.ws, "t-note", {"content": "解释", "note": "n1", "answer_style": "ste100_bilingual"},
                          BILINGUAL_ANSWER, "m", "Model")
        entry = self.ws.load("discussion")["entries"][0]
        self.assertEqual(entry["reply_to"], "n1")
        self.assertEqual(entry["body"], BILINGUAL_ANSWER)

    def test_invalid_mode_is_http_400_before_any_model_call(self):
        self.start_server()
        for value in ("unknown", "", ["ste100"], {"style": "ste100"}):
            with self.subTest(value=value), patch("easyread.server.config.load") as cfg, \
                    patch("easyread.server.chat.stream") as stream:
                with self.assertRaises(urllib.error.HTTPError) as result:
                    self.post({"text": "test", "answer_style": value})
                self.assertEqual(result.exception.code, 400)
                self.assertIn("回答方式", json.loads(result.exception.read())["error"])
                cfg.assert_not_called()
                stream.assert_not_called()
        self.assertEqual(chat_store.threads(self.ws), [])
