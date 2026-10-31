"""阅读页右侧的“问 AI”：提示词和流式输出（回答一个字一个字流出来）。

- 用哪个模型：chat_models.py（设置里的一张短名单）。
- 对话记录：chat_store.py（每篇论文可以有多个对话）。
- 上下文：论文标题、摘要、读者指着的段落和前后几段、读者引用的几处原文、术语表。
  读者的标记（按颜色分好的划线、笔记、问题）只在问题提到“标红的”“划线”“笔记”时才带上，
  提到具体颜色就只带那种颜色，所以可以问“我标红的那些公式之间有什么联系”。
  所有回答方式都附带已整理正文（超长论文按段节选）；Claude Code / Codex 还可读取本地文件。
"""
from __future__ import annotations

import json
import base64
import io
import re
import threading
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

from . import answer_styles
from ..engines import engines, netcheck, openai_api, usage
from ..engines import chat_tools
from ..translate import langs
from ..app.i18n import tr
from ..app.log import log
from ..translate.prompts import _block_text
from ..library.store import Workspace

HISTORY = 12  # 带上最近几轮对话
COLOR_NAMES = {"yellow": "黄", "green": "绿", "blue": "蓝", "pink": "红"}  # i18n-ok
MARKS_BUDGET = 9000  # 标记部分最多带多少字
PAPER_BUDGET = 30000  # 各种问答方式都带上正文，长论文各段取节选，保留后面的结果和结论


# ---------- 提示词 ----------
def _context(ws: Workspace, anchor: str | None, quote: str, refs: list[dict] | None = None) -> str:
    paper = ws.load("paper")
    meta = paper.get("meta", {})
    blocks = paper.get("blocks", [])
    lines = [f"论文：《{meta.get('title_zh') or ''}》{meta.get('title_en') or ''}，{meta.get('authors', '')[:200]}。"]  # i18n-ok
    abstract = next((_block_text(b) for b in blocks if b.get("role") == "abstract"), "")
    if abstract:
        lines.append("摘要：" + abstract[:1500])  # i18n-ok
    idx = next((i for i, b in enumerate(blocks) if b.get("id") == anchor), None)
    if idx is not None:
        h = next((b for b in reversed(blocks[:idx + 1]) if b.get("type") == "heading"), None)
        if h:
            lines.append(f"读者正在读的章节：{h.get('num', '')} {h.get('zh') or h.get('en', '')}")  # i18n-ok
        near = blocks[max(0, idx - 3): idx + 3]
        lines.append("附近的段落（有译文用译文，没译的是原文）：\n" + "\n\n".join(f"[{b['id']}] {_block_text(b)}" for b in near))  # i18n-ok
        focus = blocks[idx]
        lines.append(f"读者指着的段落 [{focus['id']}]：\n译文：{_block_text(focus)}\n原文：{focus.get('en') or focus.get('caption_en') or focus.get('tex', '')}")  # i18n-ok
    if quote:
        lines.append(f"读者选中的原话：「{quote}」")  # i18n-ok
    extra = [r for r in (refs or []) if r.get("anchor") != anchor or (r.get("quote") or "") != quote]
    if extra:
        by_id = {b.get("id"): b for b in blocks}
        parts = []
        for r in extra[:12]:
            b = by_id.get(r.get("anchor")) or {}
            q = (r.get("quote") or "").strip()
            parts.append(f"[{r.get('anchor')}] " + (f"读者选中：「{q[:800]}」\n  所在段落：" if q else "") + _block_text(b)[:1200])  # i18n-ok
        lines.append("读者引用了这几处（问题可能是在问它们之间的关系）：\n" + "\n".join(parts))  # i18n-ok
    gl = paper.get("glossary", [])
    if gl:
        lines.append("术语表：" + "；".join(f"{g['en']} = {g['zh']}" for g in gl[:80]))  # i18n-ok
    return "\n\n".join(lines)


def _paper_context(ws: Workspace) -> str:
    """跨段或全文问题也能读到后面的结果；明确标出未提供的内容。"""
    paper = ws.load("paper")
    blocks = paper.get("blocks", [])
    parts = []
    for b in blocks:
        text = b.get("en") or b.get("caption_en") or _block_text(b)
        if b.get("type") == "list":
            text = "\n".join("- " + (it.get("en") or it.get("zh", "")) for it in b.get("items", []))
        elif b.get("type") == "table":
            rows = b.get("head", []) + b.get("rows", [])
            text += "\n" + "\n".join(" | ".join(str(cell) for cell in row) for row in rows)
        if text:
            page = f"第 {b['page']} 页" if b.get("page") else ""  # i18n-ok
            parts.append(f"[{b.get('id', '')}] {page}\n{text}")
    if not parts:
        return "论文正文尚未提供；只能依据摘要、引用和当前段落回答。"  # i18n-ok
    complete = sum(map(len, parts)) + 2 * (len(parts) - 1) <= PAPER_BUDGET
    if not complete:
        limit = max(0, PAPER_BUDGET // len(parts) - 2)
        marker = "\n…（本段节选）…\n"  # i18n-ok
        clipped = []
        for part in parts:
            if len(part) > limit:
                room = max(0, limit - len(marker))
                head = (room + 1) // 2
                tail = room - head
                part = (part[:head] + marker + (part[-tail:] if tail else "")) if room else part[:limit]
            clipped.append(part)
        parts = clipped
    label = "当前已导入的正文" if complete else "正文节选（长文超出上下文预算，各段只保留部分内容）"  # i18n-ok
    total = paper.get("meta", {}).get("page_count")
    done = paper.get("translation", {}).get("done_pages")
    if total and done is not None and len(set(done)) < total:
        label += f"（只完成整理 {len(set(done))} / {total} 页）"  # i18n-ok
    return label + "；没有提供的页面和省略部分不能视为已读：\n\n" + "\n\n".join(parts)  # i18n-ok


def _marks(ws: Workspace, colors: set[str] | None = None) -> str:
    """读者的全部标记，按颜色分组；每处带上所在段落的译文（含 $TeX$），这样问“红色那些公式”也答得上。"""
    paper = ws.load("paper")
    blocks = {b.get("id"): b for b in paper.get("blocks", [])}
    order = {b.get("id"): i for i, b in enumerate(paper.get("blocks", []))}
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    notes.sort(key=lambda n: order.get(n.get("anchor"), 1e9))
    kinds = {"highlight": "划线", "note": "笔记", "question": "问题"}  # i18n-ok
    groups: dict[str, list[str]] = {}
    shown: set[str] = set()
    for n in notes:
        color = COLOR_NAMES.get(n.get("color") or "yellow", "黄") if n.get("quote") else "无颜色"  # i18n-ok
        if colors and color not in colors:
            continue
        b = blocks.get(n.get("anchor")) or {}
        line = f"- [{n.get('anchor')}] {kinds.get(n.get('kind'), '笔记')}"  # i18n-ok
        if n.get("quote"):
            line += f"：「{n['quote']}」" + ("（英文原文）" if n.get("side") == "en" else "")  # i18n-ok 发给模型的上下文
        if n.get("body"):
            line += f"；读者写道：{n['body'][:300]}"  # i18n-ok
        if b and b.get("id") not in shown:
            shown.add(b["id"])
            line += f"\n  所在段落：{_block_text(b)[:600]}"  # i18n-ok
        groups.setdefault(color, []).append(line)
    parts, used = [], 0
    for color in ["红", "黄", "绿", "蓝", "无颜色"]:  # i18n-ok
        for line in groups.get(color, []):
            if used > MARKS_BUDGET:
                break
            if not parts or not parts[-1].startswith(f"【{color}"):  # i18n-ok 发给模型的上下文
                parts.append(f"【{color}色】" if color != "无颜色" else "【没有颜色的笔记和问题】")  # i18n-ok
            parts.append(line)
            used += len(line)
    return ("读者在译文上做的标记（按颜色分组，读者说“红的”“黄色那些”就是指这里；每处附所在段落译文，行内公式是 $TeX$）：\n"  # i18n-ok
            + "\n".join(parts) + ("\n（标记太多，只列了一部分；Claude Code 可以 Read reader.json 看全部）" if used > MARKS_BUDGET else ""))  # i18n-ok


MARK_WORDS = re.compile(r"标[红黄绿蓝记了过的出注]|划线|划过|划的|画线|高亮|涂|颜色|[红黄绿蓝][色的]|笔记|批注|标记|我的问题|highlight", re.I)  # i18n-ok


def wants_marks(text: str) -> tuple[bool, set[str] | None]:
    """问题里提到“标红的”“划线”“我的笔记”这类词，才把读者的标记带上；提到具体颜色就只带那几种。"""
    if not MARK_WORDS.search(text or ""):
        return False, None
    colors = {c for c in "红黄绿蓝" if re.search(c + "[色的]|标" + c, text)}  # i18n-ok
    return True, (colors | {"无颜色"} if colors and re.search(r"笔记|问题|批注", text) else colors or None)  # i18n-ok


def _marks_summary(ws: Workspace) -> str:
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    counts: dict[str, int] = {}
    for n in notes:
        k = COLOR_NAMES.get(n.get("color") or "yellow", "黄") + "色" if n.get("quote") else "无颜色笔记"  # i18n-ok
        counts[k] = counts.get(k, 0) + 1
    return "读者在论文上做过 " + str(len(notes)) + " 处标记（" + "、".join(f"{k} {v}" for k, v in counts.items()) + "），这次问题没提到，就没附上。"  # i18n-ok


def prompt(ws: Workspace, messages: list[dict], anchor: str | None, quote: str, engine: str, refs: list[dict] | None = None,
           answer_style: str = answer_styles.DEFAULT) -> str:
    answer_style = answer_styles.parse(answer_style)
    history = messages[-HISTORY:]
    convo = "\n\n".join(("读者" if m["role"] == "user" else "你") + "：" + m["content"] for m in history[:-1])  # i18n-ok
    ask = history[-1]["content"] if history else ""
    tool = ("需要看全文时，用 Read 工具读当前目录的 paper.json（blocks 里是译文和原文）；读者的全部标记在 reader.json 的 notes 里。\n"  # i18n-ok
            if engine == "claude" else "")
    if engine in engines.CLI_ENGINES and engine != "claude":
        tool = "需要看全文或节选中省略的内容时，可以只读当前目录的 paper.json（blocks 里是译文和原文）；读者的全部标记在 reader.json 的 notes 里。\n"  # i18n-ok
    want, colors = wants_marks(ask)
    marks = _marks(ws, colors) if want else _marks_summary(ws)
    style = {answer_styles.STE100: answer_styles.STE100_INSTRUCTIONS,
             answer_styles.XRAY: answer_styles.XRAY_INSTRUCTIONS}.get(answer_style) or (
             "用" + langs.reply_lang(ws.load("paper").get("meta")) + "，直接、具体，能举例就举例。\n")  # i18n-ok
    whole = _paper_context(ws) if answer_style in answer_styles.WHOLE_PAPER else ""
    return ("你在陪读者读一篇学术论文，回答他边读边冒出来的问题。\n" + style  # i18n-ok
            + "区分“论文里写了什么”和“你的补充解释”，论文里没有的内容不要说成是论文说的。"  # i18n-ok
            "当前段落和选中文字只是提问的重点，不限制可参考的论文范围；跨章节问题应结合已提供的正文，依据不足时明确说明。"  # i18n-ok
            "行内公式只用 $TeX$，行间公式只用 $$TeX$$。"  # i18n-ok
            r"不要用 \(\) 或 \[\]，不要把公式放进反引号或代码块。"  # i18n-ok
            "行间公式的 $$ 单独占一行。公式内部可以换行，但不要在公式中插入空行；多行推导使用 aligned 环境。"  # i18n-ok
            "保留完整的上下标、括号和单位。提到原文位置时说“式 5”“第 4 页那段”，不要写 [p4-5] 这类内部编号。只输出回答本身，不要客套，不要重复问题。\n" + tool + "\n"  # i18n-ok
            + _context(ws, anchor, quote, refs)
            + ("\n\n" + whole if whole else "")
            + ("\n\n" + marks if marks else "")
            + (f"\n\n之前的对话：\n{convo}" if convo else "")  # i18n-ok
            + f"\n\n读者现在问：{ask}")  # i18n-ok


# ---------- 流式输出 ----------
def receive_images(ws: Workspace, images, ecfg: dict) -> list[str]:
    """Validate clipboard images before persisting PNGs under this paper only."""
    if images is None:
        return []
    if not isinstance(images, list) or len(images) > 4:
        raise ValueError(tr("每次最多粘贴 4 张图片"))
    if images and ecfg.get("engine") != "openai" and engines.image_mode(ecfg) == "text":
        raise ValueError(tr("当前模型未启用看图，请选择支持图片的模型"))
    from PIL import Image
    prepared, total = [], 0
    for data in images:
        if not isinstance(data, str) or len(data) > 12 * 1024 * 1024:
            raise ValueError(tr("图片过大，单张最多 8 MB"))
        match = re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", data)
        if not match:
            raise ValueError(tr("仅支持 PNG、JPEG 或 WebP 图片"))
        raw = base64.b64decode(match[1], validate=True)
        total += len(raw)
        if len(raw) > 8 * 1024 * 1024 or total > 20 * 1024 * 1024:
            raise ValueError(tr("单张图片最多 8 MB，合计最多 20 MB"))
        try:
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in ("PNG", "JPEG", "WEBP") or image.width * image.height > 16000000:
                    raise ValueError(tr("图片格式不支持或尺寸过大"))
                image.load()
                out = io.BytesIO()
                image.convert("RGBA" if "A" in image.getbands() else "RGB").save(out, "PNG")
                if out.tell() > 8 * 1024 * 1024 or sum(map(len, prepared)) + out.tell() > 20 * 1024 * 1024:
                    raise ValueError(tr("图片转存后过大，请缩小图片后重新粘贴"))
                prepared.append(out.getvalue())
        except (OSError, Image.DecompressionBombError) as error:
            raise ValueError(tr("图片无法读取，请重新复制后粘贴")) from error
    names = []
    if prepared:
        folder = ws.root / "chat-media"
        folder.mkdir(exist_ok=True)
        if not folder.resolve().is_relative_to(ws.root.resolve()):
            raise ValueError(tr("图片目录无效"))
        for raw in prepared:
            name = "chat-media/" + uuid4().hex + ".png"
            with (ws.root / name).open("xb") as file:
                file.write(raw)
            names.append(name)
    return names


def image_paths(ws: Workspace, messages: list[dict]) -> list[Path]:
    paths = []
    for message in messages[-HISTORY:]:
        for name in message.get("images", []) if isinstance(message.get("images", []), list) else []:
            if isinstance(name, str) and re.fullmatch(r"chat-media/[0-9a-f]{32}\.png", name):
                path = (ws.root / name).resolve()
                if path.is_relative_to(ws.root.resolve()) and path.is_file() and path not in paths:
                    paths.append(path)
    return paths[-4:]


def stream(ecfg: dict, text: str, cwd: Path, cancel: threading.Event, on_model=None, meter=None, images: list[Path] | None = None) -> Iterator[str]:
    """on_model(实际模型名)：Claude Code 开头会报它实际用的模型。meter：传了就记下这次回答的 token 用量。"""
    e = ecfg.get("engine")
    bad = netcheck.problem(ecfg)
    if bad:
        raise engines.EngineError(bad)
    images = images or []
    if images and e == "openai":
        ecfg["openai"]["vision"] = True  # Explicit attachments enable multimodal payloads for this request only.
    if images and engines.image_mode(ecfg) == "text":
        raise engines.EngineError(tr("当前模型未启用看图，请选择支持图片的模型"))
    if images and engines.image_mode(ecfg) == "claude":
        text += "\n\n读者附上的图片，请用读图工具查看这些本地文件：\n" + "\n".join(str(path) for path in images)  # i18n-ok
    try:
        if e in engines.CLI_ENGINES:
            text += chat_tools.RESEARCH_PROMPT
        if e == "claude":
            yield from _stream_claude(ecfg["claude"], text, cwd, cancel, on_model, meter)
        elif e == "openai":
            yield from openai_api.stream(ecfg["openai"], text, cancel, meter, images=images)
        else:  # codex 没有逐字输出，整段给；不拉起用户的 MCP 和用不到的功能（见 codex_lean）
            yield engines.run(chat_tools.for_chat(ecfg), text, cwd, images, cancel, meter)
    except engines.EngineError as err:
        raise engines.EngineError(netcheck.explain(ecfg, str(err))) from None


def _stream_claude(c: dict, text: str, cwd: Path, cancel, on_model=None, meter=None) -> Iterator[str]:
    """问答可读取、搜索论文和网页；保持无写入、无命令执行的工具范围。"""
    exe = engines.claude_path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 Claude Code 命令（先装好并登录 Claude Code）"))
    args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--allowedTools", chat_tools.READ_TOOLS, "--disallowedTools", chat_tools.DENIED_TOOLS,
            "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    if c.get("model"):
        args += ["--model", c["model"]]
    if c.get("reasoning_effort"):
        args += ["--effort", c["reasoning_effort"]]
    said = []
    try:
        for piece in _stream_once(args + ["--tools", chat_tools.READ_TOOLS], text, cwd, cancel, on_model, meter):
            said.append(piece)
            yield piece
    except engines.EngineError as e:
        if said or not engines.option_unknown(e):
            raise
        log.warning("Claude Code 不认 --tools，照旧调用：%s", str(e)[-300:])
        yield from _stream_once(args, text, cwd, cancel, on_model, meter)


def _stream_once(args: list[str], text: str, cwd: Path, cancel, on_model=None, meter=None) -> Iterator[str]:
    proc = engines._popen(args, cwd)
    proc.stdin.write(text)
    proc.stdin.close()
    done = threading.Event()

    def kill_on_cancel():
        while not done.wait(0.2):
            if cancel.is_set():
                if proc.poll() is None:
                    proc.kill()
                return

    threading.Thread(target=kill_on_cancel, daemon=True).start()
    got = False
    rate = None
    try:
        for line in proc.stdout:
            if cancel.is_set():
                raise engines.Cancelled()
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "system" and ev.get("subtype") == "init" and ev.get("model") and on_model:
                on_model(ev["model"])
            if ev.get("type") == "stream_event":
                d = (ev.get("event") or {}).get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    got = True
                    yield d["text"]
            elif ev.get("type") == "rate_limit_event":
                rate = ev
            elif ev.get("type") == "result":
                if meter is not None:
                    meter.add(**usage.from_claude(ev, rate))
                if ev.get("is_error"):
                    raise engines.EngineError(tr("Claude Code 出错：{detail}", detail=str(ev.get("result") or ev.get("subtype"))))
                if not got and ev.get("result"):
                    yield ev["result"]
                return
        err = proc.stderr.read()[-400:]
        if not got:
            raise engines.EngineError(err or tr("Claude Code 没有输出"))
    finally:
        if proc.poll() is None:
            proc.kill()
        done.set()  # 让 kill_on_cancel 线程退出
