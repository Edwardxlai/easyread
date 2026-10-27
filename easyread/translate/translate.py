"""后台翻译：一批几页交给模型，校验后并进 paper.json。每批落盘，中断了下次接着译。

一批失败会重试；还是失败就记下来跳过，接着译后面的页，最后在页面上给“重试失败的页”。
"""
from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from . import codeblocks, consistency, continuation, front_context, langs, page_check, prompts, prompts_en, segments, sentences, terms
from ..engines import engines, netcheck
from ..pdf import figures, pdfwork, sources, blank_pages
from ..library.checks import block_problems, tex_problems
from ..pdf.figures import normalize_figure, prepare_figures
from ..app.i18n import tr
from ..app.log import log
from ..library.paperdata import add_discussion, fill_zh, merge_blocks, set_block_text
from ..library.store import Workspace
from .page_scope import references_page, scope_pages
from .translator_checks import journal, save_checks as _save_checks
from .repair_guard import retains_content
from . import instructions, figure_images

_merge_lock = threading.Lock()  # 并发翻译时，并入 paper.json 和重算原页定位一次只做一个
# 用量到顶、余额不足这类错误，后面的批次也一定失败：直接停，剩下的页记为没译，等额度恢复后一键重试
_QUOTA = re.compile(r"session limit|usage limit|rate limit reached|insufficient_quota|余额不足|额度|接口返回 40[12]|insufficient balance|API returned 40[12]", re.I)  # i18n-ok


def prepare(ws: Workspace) -> None:
    pages = pdfwork.prepare(ws.root)
    extra = {}
    try:  # 本地拖进来的 PDF：从第一页的 arXiv 编号或 DOI 补上作者、年份、出处
        first = ws.root / "extract" / "page-001.txt"
        if first.exists():
            extra = sources.enrich(first.read_text(encoding="utf-8", errors="replace"), ws.load("paper").get("meta", {}))
    except Exception:  # noqa: BLE001
        log.exception("补元数据失败 %s", ws.id)

    def apply(paper):
        meta = paper.setdefault("meta", {})
        meta.update({"pages": pages, "page_count": len(pages)})
        for k, v in extra.items():
            if not meta.get(k) or (k == "title_en" and meta.get(k) == meta.get("source", "").removesuffix(".pdf")):
                meta[k] = v
    ws.update("paper", apply)


def _next_head(ws: Workspace, n: int, whole: bool = False) -> str:
    """下一页开头的抽取文字。whole：整页都给（不能看图的引擎在分段交界处，续文可能排在表格、图注后面）。"""
    p = ws.root / "extract" / f"page-{n:03d}.txt"
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8")
    return text if whole else text[:1500]


def _normalize(data: dict, pages: list[int], taken: set[str]) -> dict:
    """补页码、去掉和已有块撞车的 id、丢掉明显无效的块。"""
    if isinstance(data, list):
        data = {"blocks": data}
    blocks = []
    for b in data.get("blocks") or []:
        if not isinstance(b, dict) or not b.get("type"):
            continue
        codeblocks.normalize(b)
        b.setdefault("page", pages[0])
        try:
            b["page"] = int(b["page"])
        except (TypeError, ValueError):
            b["page"] = pages[0]
        bid = re.sub(r"[^A-Za-z0-9_\-]", "-", str(b.get("id") or f"p{b['page']}-{len(blocks) + 1}"))
        base, k = bid, 2
        while bid in taken:
            bid = f"{base}-{k}"
            k += 1
        taken.add(bid)
        b["id"] = bid
        if b["type"] == "figure":
            b.pop("translated_image", None)  # Only the image editor may publish an image result.
            b.setdefault("src", "")
            normalize_figure(b)  # 截图要等合并锁里 id 最终去重之后，见 prepare_figures
        blocks.append(b)
    data["blocks"] = blocks
    return data


def _taken(ws: Workspace, batch: list[int]) -> set[str]:
    return {b["id"] for b in ws.load("paper").get("blocks", []) if b.get("page") not in batch}


def _problems(data: dict) -> list[str]:
    problems, tex = block_problems(data["blocks"])
    return problems + tex_problems(tex)


def _fill_problems(zh: dict) -> list[str]:
    # Fill responses use keys instead of blocks; table heads still need math checks.
    blocks = [{"id": k, "type": "table", "head": v} if k.endswith("#head") else
              {"id": k, "type": "para", "zh": v}
              for k, v in zh.items() if isinstance(v, str) or k.endswith("#head")]
    return _problems({"blocks": blocks})


def _fill_batch(ws: Workspace, cfg: dict, batch: list[int], cancel, say, meter=None, wait=False) -> None:
    """只读原文整理过的页：不重排，只给已有的块补译文。漏译的键抛错，重试时只译剩下的。
    没有块的页（整页是上一段的续文）要等那段有了译文才算译完；wait：上一页还在别的段里译，先放着等全部译完再核对。"""
    blocks = [b for b in ws.load("paper").get("blocks", []) if b.get("page") in batch]
    empty = [n for n in batch if not any(b.get("page") == n for b in blocks)]
    items = prompts_en.todo(blocks)
    if cfg.get("translate_figure_text") is False:
        items = {k: v for k, v in items.items() if not k.endswith("#image")}
    if not items:
        with _merge_lock:
            fill_zh(ws, {}, [n for n in batch if n not in empty], set())
            continuation.fill_empty(ws, empty, wait)
        return
    marked, ends = sentences.mark_items(blocks, items)  # 英文先按句插好 ‖，译文照着插，记句子对齐
    text = engines.run(cfg, instructions.apply(prompts_en.fill(ws, batch, marked), cfg), ws.root, None, cancel, meter)
    data = engines.parse_json(text)
    if not isinstance(data, dict) or not isinstance(data.get("zh"), dict):
        raise engines.EngineError(tr("模型输出的格式不对（缺 zh）"))
    problems = _fill_problems(data["zh"])
    if problems:
        say(tr("第 {page} 页起有 {n} 处公式或格式问题，正在让模型修正", page=batch[0], n=len(problems)))
        try:
            fixed = engines.parse_json(engines.run(cfg, instructions.apply(prompts.repair(prompts.dump(data), problems), cfg), ws.root, None, cancel, meter))
            if (isinstance(fixed, dict) and isinstance(fixed.get("zh"), dict)
                    and data["zh"].keys() <= fixed["zh"].keys()
                    and retains_content(data, fixed)
                    and len(_fill_problems(fixed["zh"])) < len(problems)):
                data = fixed
        except engines.EngineError as e:
            journal(ws, tr("第 {pages} 页修正失败，保留原译：{err}", pages=batch, err=e))
    instructions.filter_figure_text(data, cfg)
    with _merge_lock:
        _unify_terms(ws, data, batch, {k: v if isinstance(v, str) else json.dumps(v, ensure_ascii=False) for k, v in items.items()})
        missing = fill_zh(ws, data, [n for n in batch if n not in empty], set(items), sentences.unmark_fill(data["zh"], ends))
        _save_checks(ws, data.get("checks"), batch)
        if not missing:
            continuation.fill_empty(ws, empty, wait)
    if missing:
        raise engines.EngineError(tr("漏译了 {n} 处（{ids}）", n=len(missing), ids=", ".join(missing[:5])))


def _one_batch(ws: Workspace, cfg: dict, batch: list[int], total_pages: int, cancel, say, meter=None, read=False,
               skip_head=False, peek=(), front=False, wait=False) -> None:
    """read：只读原文，整理成块但不翻译。skip_head：上一页由另一段同时在译，页首续文归它。
    peek：分段交界处顺便看一眼的相邻页（见 prompts.peek_note）。front：带上前文参考（每段第一批，见 front_context）。
    wait：上一页还没译好，模型返回空时先放着，等全部译完再核对是不是续文。"""
    mode = engines.image_mode(cfg)
    images = [pdfwork.engine_image(ws.root, n) for n in sorted({*batch, *peek})] if mode != "text" else []
    nxt = batch[-1] + 1
    # 分段交界、引擎不能看图：前一段最后一批拿下一页全文补完跨页那段（后一段第一批会跳过页首续文，这里补不全就丢了）
    head = _next_head(ws, nxt, whole=mode == "text" and nxt in peek) if nxt <= total_pages else ""
    if read:
        prompt = prompts_en.structure(ws, batch, mode, head, skip_head, peek)
    else:
        prompt = prompts.translate(ws, batch, mode, head, skip_head, peek, front_context.build(ws.root, batch[0]) if front else "")
    text = engines.run(cfg, prompt if read else instructions.apply(prompt, cfg), ws.root, images, cancel, meter)
    try:
        data = engines.parse_json(text)
    except engines.EngineError:
        (ws.root / "extract" / f"failed-{batch[0]:03d}.txt").write_text(text, encoding="utf-8")
        raise
    data = _normalize(data, batch, _taken(ws, batch))
    problems = _problems(data)
    if problems:  # 给一次修的机会
        say(tr("第 {page} 页起有 {n} 处公式或格式问题，正在让模型修正", page=batch[0], n=len(problems)))
        try:
            repair = prompts.repair(prompts.dump(data), problems)
            fixed = engines.parse_json(engines.run(cfg, repair if read else instructions.apply(repair, cfg), ws.root, None, cancel, meter))
            fixed = _normalize(fixed, batch, _taken(ws, batch))
            if fixed["blocks"] and retains_content(data, fixed) and len(_problems(fixed)) < len(problems):
                data = fixed
        except engines.EngineError as e:
            journal(ws, tr("第 {pages} 页修正失败，保留原译：{err}", pages=batch, err=e))
    with _merge_lock:
        # 整页都是参考文献时只有 references，没有新块，也算译完；整批都是跨页续文、已经并进上一段时也不用重复输出
        if not data["blocks"] and not data.get("references") and not continuation.covered(ws, batch, read):
            if wait:
                raise continuation.WaitPrev(batch, read, lambda: merge_blocks(ws, {"blocks": []}, done=batch, replace_pages=batch, en_only=read))
            raise engines.EngineError(tr("模型没有整理出任何内容") if read else tr("模型没有译出任何内容"))
        data = _normalize(data, batch, _taken(ws, batch))  # 并发时别的批可能刚占用了同名 id
        missing = page_check.missing_pages(ws, batch, data)  # 有的页有内容、有的页整页漏了：漏的页不算译完
        keep = [n for n in batch if n not in missing]
        if not read:
            instructions.filter_figure_text(data, cfg)
        prepare_figures(ws.root, data["blocks"], total_pages)
        _unify_terms(ws, data, batch)
        drop = _one_references(ws, data, batch)
        merge_blocks(ws, data, done=keep, replace_pages=keep, en_only=read, drop_ids=drop)
        _save_checks(ws, data.get("checks"), batch)
        try:
            pdfwork.locate(ws.root)
            figures.fill(ws)  # 按定位重截：PDF 图形边界认出了图就替换模型框截的图
        except Exception:  # noqa: BLE001 —— 定位失败不影响阅读
            log.exception("locate 失败 %s", ws.id)
    if missing:
        raise page_check.MissingPages(missing)


def _one_references(ws: Workspace, data: dict, batch: list[int]) -> list[str]:
    """全文只留一个“参考文献”块（页面上它会把整张参考文献表画出来，两个就画两遍）。
    参考文献跨了几批（分段并行时可能两段各起一个）时留页码最早的那个；这批的更早，就接过已有那块的 id
    （挂在上面的笔记还挂得住），返回要在合并时一并删掉的旧块 id。在合并锁里调。"""
    mine = [b for b in data["blocks"] if b.get("type") == "references"]
    if not mine:
        return []
    others = [b for b in ws.load("paper").get("blocks", []) if b.get("type") == "references" and b.get("page") not in batch]
    keep = min(mine, key=lambda b: b.get("page") or 0)
    data["blocks"] = [b for b in data["blocks"] if b.get("type") != "references" or b is keep]
    if not others:
        return []
    if min(b.get("page") or 0 for b in others) <= (keep.get("page") or 0):
        data["blocks"].remove(keep)
        return []
    keep["id"] = others[0]["id"]
    return [b["id"] for b in others]


def _unify_terms(ws: Workspace, data: dict, batch: list[int], en_of: dict | None = None) -> None:
    """这批新报的术语和术语表里已有的译法不同（分段并行时几段各自先定了译法）：译文改成已有的说法。在合并锁里调。"""
    for en, mine, old in terms.unify(ws.load("paper").get("glossary", []), data, en_of):
        journal(ws, tr("第 {page} 页起术语统一：{en} 的“{mine}”改成已有的“{old}”", page=batch[0], en=en, mine=mine, old=old))


def _batches(pages: list[int], size: int, en_pages: set[int]) -> list[list[int]]:
    """分批：只把连续的页放一批（续传时中间隔着已译的页，跨页续文对不上）；只读原文整理过的页（补译文）和要从头译的页不混在一批里。"""
    out: list[list[int]] = []
    for n in pages:
        if out and n == out[-1][-1] + 1 and len(out[-1]) < size and (out[-1][0] in en_pages) == (n in en_pages):
            out[-1].append(n)
        else:
            out.append([n])
    return out


def translate_pages(ws: Workspace, cfg: dict, pages: list[int], cancel, report, meter=None, read=False) -> dict[int, str]:
    """翻译给定的页（已完成的页会重译并替换；只读原文整理过的页就地补译文）。report(done, total, message)；
    meter 收集 token 用量。read：只读原文，把页整理成块但不翻译。返回没做成的页 {页码: 原因}。"""
    if cancel.is_set():
        raise engines.Cancelled()
    blank = blank_pages.find(ws, pages, cancel)
    if cancel.is_set():
        raise engines.Cancelled()
    if blank:
        with _merge_lock:
            merge_blocks(ws, {"blocks": []}, done=blank)
        pages = [n for n in pages if n not in blank]
    if not pages:
        report(len(blank), len(blank), tr("结束，全部成功"))
        return {}
    if blank:
        original_report = report
        report = lambda done, total, message: original_report(done + len(blank), total + len(blank), message)
    cfg = engines.for_translation(cfg)  # 本机 CLI 不加载用户的 MCP、多余的工具定义（问 AI 不走这里）
    paper = ws.load("paper")
    total_pages = paper.get("meta", {}).get("page_count") or 0
    en_pages = set() if read else set(paper.get("translation", {}).get("en_pages", []))
    size = max(1, int(cfg.get("batch_pages") or 2))
    # 分段并行：切成几段连续的页同时译，段内一批接一批（见 segments.py）
    k = segments.workers(cfg.get("concurrency"), len(_batches(pages, size, en_pages)))
    lanes = [_batches(seg, size, en_pages) for seg in segments.plan(pages, size, k, ws.root)]
    batches = [b for lane in lanes for b in lane]
    verb = tr("正在整理原文") if read else tr("正在翻译")
    workers = max(1, len(lanes))
    job_pages = set(pages)
    had = set(paper.get("translation", {}).get("done_pages", [])) - en_pages  # 开译前已经有译文的页
    lane_of = {n: i for i, lane in enumerate(lanes) for b in lane for n in b}
    state = {"done": 0, "active": set(), "quota": "", "ok": set(), "later": []}  # ok：这次已经做成的页；later：等全部译完再核对的续文
    failed: dict[int, str] = {}
    lock = threading.Lock()
    bad = netcheck.problem(cfg)
    if bad:
        raise engines.EngineError(bad)
    if not read and not paper.get("meta", {}).get("target"):  # 第一次翻译时记下译文语言，之后改设置不影响这篇
        old_zh = any(b.get("zh") or b.get("caption_zh") for b in paper.get("blocks", []))  # 1.3 以前译的都是中文
        target = "zh" if old_zh else langs.of_paper(paper.get("meta"), cfg)
        ws.update("paper", lambda p: p.setdefault("meta", {}).setdefault("target", target))
    journal(ws, (tr("只读原文（不翻译）") if read else "") + tr("开始：{pages} 页，{batches} 批，引擎 {engine}，并发 {workers}", pages=len(pages), batches=len(batches), engine=engines.engine_name(cfg.get("engine")), workers=workers))

    def label(batch):
        return tr("第 {a}–{b} 页", a=batch[0], b=batch[-1]) if len(batch) > 1 else tr("第 {page} 页", page=batch[0])

    if workers > 1:
        journal(ws, tr("分 {n} 段同时译：{ranges}", n=workers, ranges=tr("、").join(label(sorted({lane[0][0], lane[-1][-1]})) for lane in lanes)))

    def say(msg=None):
        with lock:
            active = sorted(state["active"])
            text = msg or (verb + tr("、").join(label(b) for b in active) if active else verb)
            report(state["done"], len(pages), text)

    def work(batch):
        if cancel.is_set():
            return
        if state["quota"]:  # 额度用完了，不再白跑
            with lock:
                state["done"] += len(batch)
                for n in batch:
                    failed[n] = state["quota"]
            return
        with lock:
            state["active"].add(tuple(batch))
            p = batch[0] - 1  # 上一页这次也要译、还没译好（在别的段里同时译）：跨页那段归它，这批跳过页首续文
            skip_head = p in job_pages and p not in state["ok"] and p not in en_pages
            # 交界两边都看一眼相邻页的原页图：后一段第一批看上一页末尾，前一段最后一批看下一页开头
            q = batch[-1] + 1
            # 下一页存在、不在本段（别的段在译，或者断点续传时已经译过、跳过了页首续文）：本批负责把跨页那段补完整
            owner = q <= total_pages and lane_of.get(q) != lane_of[batch[-1]] and q not in en_pages
            peek = ([p] if skip_head else []) + ([q] if owner else [])
            # 每段第一批、上一页还没有译文（同时在别的段里译，或从没译过）：给原文的前文参考
            front = batch is lanes[lane_of[batch[0]]][0] and batch[0] > 1 and (p not in had or skip_head)
            wait = p in job_pages and p not in state["ok"]  # 上一页这次也要译、还没做成：返回空时现在核对不了续文
        say()
        err, todo = None, batch
        for attempt in range(2):
            try:
                if todo[0] in en_pages:
                    _fill_batch(ws, cfg, todo, cancel, say, meter, wait)
                elif todo is batch:
                    _one_batch(ws, cfg, batch, total_pages, cancel, say, meter, read, skip_head, peek, front, wait)
                else:  # 只重译这批里漏掉的页：前面的页已经并进去了，不用再跳过页首续文
                    _one_batch(ws, cfg, todo, total_pages, cancel, say, meter, read)
                with lock:
                    state["ok"].update(todo)
                journal(ws, tr("{pages} 完成", pages=label(todo)))
                err = None
                break
            except page_check.MissingPages as e:
                with lock:
                    state["ok"].update(n for n in todo if n not in e.pages)
                todo = e.pages
                err = tr("模型漏译了这一页")
                journal(ws, tr("{pages} 模型整页漏译，单独再译一次", pages=label(todo)))
            except continuation.WaitPrev as e:
                with lock:
                    state["ok"].update(n for n in batch if n not in e.pages)
                    # 核对不上时再译一次（相当于失败重试，只是挪到最后）：那时上一页已经译完，不用再跳过页首续文
                    # 补译文的页不用：没有块要译，只等所属段落有译文
                    retry = None if batch[0] in en_pages else (
                        lambda: _one_batch(ws, cfg, batch, total_pages, cancel, say, meter, read, False, [q] if owner else [], False))
                    state["later"].append((e, retry))
                journal(ws, tr("{pages} 没有新内容，等上一页译完再核对是不是上一段的续文", pages=label(e.pages)))
                err = None
                break
            except engines.Cancelled:
                raise
            except Exception as e:  # noqa: BLE001
                err = str(e) if isinstance(e, engines.EngineError) else f"{type(e).__name__}: {e}"
                journal(ws, tr("{pages} 第 {n} 次失败：{err}", pages=label(todo), n=attempt + 1, err=err[:500]))
                log.warning("翻译失败 %s %s: %s", ws.id, todo, err[:300])
                if cancel.is_set():
                    raise engines.Cancelled()
                if _QUOTA.search(err) or netcheck.offline(err):
                    state["quota"] = err[:300]
                    journal(ws, tr("额度用完或连不上，停止翻译剩下的页"))
                    break
        with lock:
            state["active"].discard(tuple(batch))
            state["done"] += len(batch)
            if err:
                for n in todo:
                    failed[n] = err[:300]
        say()

    def run_lane(lane):
        for batch in lane:
            if cancel.is_set():
                return
            work(batch)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run_lane, lane) for lane in lanes]
        for f in futures:
            f.result()  # Cancelled 在这里抛出去
    if cancel.is_set():
        raise engines.Cancelled()
    for e, retry in sorted(state["later"], key=lambda x: x[0].pages[0]):  # 按页序：连着几批都是续文时，前一批先记完成
        err = continuation.settle(ws, e, _merge_lock, None if state["quota"] else retry, lambda m: journal(ws, f"{label(e.pages)} {m}"))
        failed.update(dict.fromkeys(e.pages, err) if err else {})
        state["ok"].update([] if err else e.pages)
        journal(ws, tr("{pages} 失败：{err}", pages=label(e.pages), err=err) if err else tr("{pages} 完成", pages=label(e.pages)))
    if not read and len(batches) > 1 and not state["quota"] and state["ok"]:
        try:  # 检查失败或这时取消，都不影响已经译好的内容：照常结束，不算取消
            report(state["done"], len(pages), tr("正在检查术语一致性"))
            consistency.check(ws, cfg, sorted(state["ok"]), cancel, meter, journal, _merge_lock)
        except engines.Cancelled:
            journal(ws, tr("术语一致性检查已取消，译文保留"))
        except Exception as e:  # noqa: BLE001
            journal(ws, tr("术语一致性检查没做成：{err}", err=str(e)[:300]))
            log.warning("术语一致性检查失败 %s: %s", ws.id, e)
    if not read and state["ok"]:
        figure_images.generate(ws, cfg, state["ok"], cancel,
                               lambda msg: report(state["done"], len(pages), msg), meter)
    journal(ws, tr("结束，{n} 页失败：{pages}", n=len(failed), pages=sorted(failed)) if failed else tr("结束，全部成功"))
    return failed


def answer(ws: Workspace, cfg: dict, note_id: str, cancel) -> None:
    note = ws.load("reader").get("notes", {}).get(note_id)
    if not note:
        raise KeyError(note_id)
    text = engines.run(engines.for_translation(cfg), prompts.answer(ws, note), ws.root, None, cancel).strip()
    if not text:
        raise engines.EngineError(tr("模型没有给出回答"))
    add_discussion(ws, [{"reply_to": note_id, "kind": "reply", "body": text, "by": engines.who(cfg)}])


def retranslate(ws: Workspace, cfg: dict, key: str, hint: str, cancel) -> None:
    prompt, en_ends = prompts.retranslate(ws, key, hint)
    cfg = {**cfg, "target": langs.of_paper(ws.load("paper").get("meta"))}
    prompt = instructions.apply(prompt, cfg)
    data = engines.parse_json(engines.run(engines.for_translation(cfg), prompt, ws.root, None, cancel))
    zh = (data or {}).get("zh", "").strip() if isinstance(data, dict) else ""
    if not zh:
        raise engines.EngineError(tr("模型没有给出新译文"))
    zh, sents = sentences.zh_sents(*en_ends, zh) if en_ends else (sentences.strip(zh), None)
    set_block_text(ws, key, zh, sents)
