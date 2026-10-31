"""Run BabelDOC in its own Python environment using EasyRead's selected engine.

The parent sends configuration on stdin, never in process arguments or files.
Invoke this file directly so the optional BabelDOC dependencies stay isolated.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from babeldoc.docvision.doclayout import DocLayoutModel
from babeldoc.format.pdf.high_level import async_translate
from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
from babeldoc.translator.translator import BaseTranslator

from easyread.engines import engines


class EasyReadTranslator(BaseTranslator):
    name = "easyread"

    def __init__(self, cfg: dict, cwd: Path, target: str):
        super().__init__("en", target, ignore_cache=False)
        self.cfg = engines.for_translation(cfg)
        self.cwd = cwd
        engine = cfg["engine"]
        self.model = cfg.get(engine, {}).get("model") or engine
        self.errors: list[str] = []
        self.add_cache_impact_parameters("engine", engine)
        self.add_cache_impact_parameters("model", self.model)
        self.add_cache_impact_parameters("adapter_version", 1)
        if engine == "codex":
            # This route uses the user's ChatGPT login, with no API fallback.
            for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
                os.environ.pop(name, None)
            options = self.cfg["codex"]
            options["extra_args"] = [*options.get("extra_args", []), "-c", 'forced_login_method="chatgpt"']

    def do_llm_translate(self, text, rate_limit_params=None):
        # BabelDOC probes LLM support with None before submitting paragraphs.
        if text is None:
            return None
        try:
            result = engines.run(self.cfg, text, self.cwd).strip()
            if not result:
                raise engines.EngineError("The translation engine returned an empty response")
            return result
        except Exception as exc:
            self.errors.append(str(exc))
            raise

    def do_translate(self, text, rate_limit_params=None):
        return self.do_llm_translate(
            f"Translate the following text from {self.lang_in} to {self.lang_out}. "
            "Return only the translation, preserving all formatting placeholders.\n\n" + text,
            rate_limit_params,
        )


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--target", default="zh")
    parser.add_argument("--pages")
    parser.add_argument("--mono-only", action="store_true")
    args = parser.parse_args()
    cfg = json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="easyread-pdf-engine-") as temporary:
        translator = EasyReadTranslator(cfg, Path(temporary), args.target)
        layout = DocLayoutModel.load_onnx()
        settings = TranslationConfig(
            translator=translator, input_file=Path(args.input), lang_in="en", lang_out=args.target,
            doc_layout_model=layout, output_dir=Path(args.output), pages=args.pages,
            only_include_translated_page=bool(args.pages),
            no_dual=args.mono_only,
            watermark_output_mode=WatermarkOutputMode.NoWatermark,
            pool_max_workers=2, term_pool_max_workers=1, qps=1,
            auto_extract_glossary=False, use_rich_pbar=False,
        )
        getattr(layout, "init_font_mapper", lambda _: None)(settings)
        finished = False
        async for event in async_translate(settings):
            if event["type"] == "error":
                raise RuntimeError(str(event.get("error") or "PDF translation failed"))
            if event["type"] == "finish":
                finished = True
            if event["type"] in ("progress_start", "progress_end", "finish"):
                print(json.dumps({k: event[k] for k in ("type", "stage") if k in event}), flush=True)
            if finished:
                break
        if translator.errors:
            raise RuntimeError(translator.errors[-1])
        if not finished:
            raise RuntimeError("BabelDOC did not complete the export")


if __name__ == "__main__":
    asyncio.run(main())
