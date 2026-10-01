"""命令行。给人用，也给对话里的 agent 用（它在对话里翻译、追加讨论时走这些命令）。

  easyread serve [--open] [--port N]      启动（或复用已在跑的）服务
  easyread stop                           暂停任务并退出本机服务
  easyread list                           列出文献库
  easyread import 论文.pdf|arXiv编号 [--no-translate]
  easyread translate ID [--pages 3-5]     排队翻译（需要服务在跑；否则直接前台译）
  easyread status ID                      译文进度、用户改过的译文、笔记、待回答的问题
  easyread blocks ID --from 批次.json [--done 4-6] [--replace]
  easyread discuss ID --from 讨论.json | --delete 讨论ID
  easyread check ID                       检查块、引用、TeX
  easyread locate ID                      重新计算原页高亮位置
  easyread export ID                      导出单文件离线 HTML
  easyread demo ID --out docs/demo        做成网站上的在线演示（图片另存、带问 AI 记录）
  easyread merge ID --from 导出.json       把离线版页面导出的修改并回文献库
  easyread migrate 旧的“xxx-共读”目录      把旧版技能生成的目录搬进文献库
ID 可以写开头几位，能唯一确定就行。
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import urllib.request
from pathlib import Path

from . import config, paperdata, pdfwork
from .checks import check
from .library import Library, migrate_folder
from .store import read_json, text_hash


def out(s=""):
    sys.stdout.write(s + "\n")


def lib() -> Library:
    return Library(config.library_dir())


def find(pid: str):
    matches = [ws for ws in lib().all() if ws.id.startswith(pid)]
    if len(matches) != 1:
        sys.exit(f"找不到唯一的论文：{pid}（匹配 {len(matches)} 篇）")
    return matches[0]


def running_server() -> str | None:
    info = read_json(config.SERVER_INFO, {}) or {}
    if not info.get("url"):
        return None
    try:
        urllib.request.urlopen(info["url"] + "/api/config", timeout=1.5)
        return info["url"]
    except Exception:  # noqa: BLE001
        return None


def cmd_serve(a):
    import os
    url = None if (a.port is not None or config.temp_library()) else running_server()
    if url:
        out(f"服务已在运行：{url}")
        if a.open:
            import webbrowser
            webbrowser.open(url)
        return
    from .server import serve
    serve(a.port, a.open, exit_on_close=a.exit_on_close)


def cmd_stop(a):
    import time
    url = running_server()
    if not url:
        out("EasyRead 服务已关闭。")
        return
    with urllib.request.urlopen(url + "/api/lifecycle", timeout=3) as response:
        token = json.loads(response.read())["token"]
    req = urllib.request.Request(url + "/api/shutdown", data=b"{}",
                                 headers={"X-Token": token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=3):
        pass
    end = time.monotonic() + 15
    while time.monotonic() < end:
        if not running_server():
            out("EasyRead 服务已退出，未完成的翻译已暂停。")
            return
        time.sleep(0.2)
    sys.exit("服务还在退出中，请稍后重试。")


def cmd_list(a):
    for s in lib().list():
        job = s.get("job") or {}
        out(f"{s['id']}  {s['title_zh'] or s['title_en']}  [{s['done_pages']}/{s['pages']} 页] {job.get('state', '')} {job.get('message', '')}")


def cmd_import(a):
    L = lib()
    src = a.source
    if Path(src).exists():
        ws, fresh = L.create_from_pdf(Path(src).read_bytes(), Path(src).name)
    else:
        data, name, meta = L.fetch(src)
        ws, fresh = L.create_from_pdf(data, name, meta)
    if not fresh:
        out(f"已在库里：{ws.id}")
        return
    from .translate import prepare
    prepare(ws)
    out(f"已导入：{ws.id}（{ws.root}）")
    if not a.no_translate:
        cmd_translate(argparse.Namespace(id=ws.id, pages=None))


def cmd_translate(a):
    ws = find(a.id)
    url = running_server()
    pages = paperdata.parse_pages(a.pages) if a.pages else None
    if url:
        token = json.loads(urllib.request.urlopen(url + "/api/library").read())["token"]
        req = urllib.request.Request(f"{url}/api/p/{ws.id}/translate", data=json.dumps({"pages": pages}).encode(),
                                     headers={"X-Token": token, "Content-Type": "application/json"})
        urllib.request.urlopen(req)
        out("已交给服务排队翻译，进度在文献库页面上看。")
        return
    from .translate import translate_pages
    cfg = config.load()
    paper = ws.load("paper")
    done = set(paper.get("translation", {}).get("done_pages", []))
    pages = pages or [p["n"] for p in paper["meta"]["pages"] if p["n"] not in done]
    failed = translate_pages(ws, cfg, pages, threading.Event(), lambda d, t, m: out(f"[{d}/{t}] {m}"))
    if failed:
        out(f"没译成功的页：{sorted(failed)}，原因见 {ws.root / 'job.log'}")


def cmd_status(a):
    ws = find(a.id)
    paper, reader, disc = ws.load("paper"), ws.load("reader"), ws.load("discussion")
    blocks = {b["id"]: b for b in paper.get("blocks", []) if b.get("id")}
    tr = paper.get("translation", {})
    out(f"# {paper.get('meta', {}).get('title_zh') or paper.get('meta', {}).get('title_en')}  ({ws.id})")
    out(f"目录：{ws.root}")
    out(f"译文范围：{tr.get('scope')}；已完成页 {tr.get('done_pages')}")
    job = ws.load("job") or {}
    if job:
        out(f"后台任务：{job.get('state')} {job.get('message')} {job.get('error', '')}")
    edits = {k: v for k, v in reader.get("edits", {}).items() if v.get("zh") is not None}
    out(f"\n## 用户改过的译文（{len(edits)}）")
    for key, e in edits.items():
        bid, _, field = key.partition("#")
        b = blocks.get(bid, {})
        agent = b.get("caption_zh") if field == "caption" else (b.get("items", [{}] * 99)[int(field)].get("zh") if field.isdigit() else b.get("zh", ""))
        stale = " [译者稿在用户修改后又变过]" if e.get("base") and e["base"] != text_hash(agent) else ""
        out(f"- {key}{stale}\n  用户：{e['zh']}\n  译者：{agent}")
    notes = [n for n in reader.get("notes", {}).values() if not n.get("deleted")]
    replied = {e.get("reply_to") for e in disc.get("entries", []) if e.get("reply_to")}
    out(f"\n## 用户笔记与划线（{len(notes)}）")
    for n in sorted(notes, key=lambda n: n.get("created", "")):
        flag = (" [已回复]" if n["id"] in replied else " [待回答]") if n.get("kind") == "question" else ""
        quote = f"「{n['quote']}」" if n.get("quote") else ""
        out(f"- {n['id']} · {n.get('kind')}{flag} · 块 {n.get('anchor')} {quote}\n  {(n.get('body') or '').strip()}")
    pn = (reader.get("paper_note") or {}).get("body")
    if pn:
        out(f"\n## 论文笔记\n{pn}")
    out(f"\n## 讨论条目：{len(disc.get('entries', []))}")


def cmd_blocks(a):
    ws = find(a.id)
    data = json.loads(Path(a.from_file).read_text(encoding="utf-8"))
    replace = paperdata.parse_pages(a.done) if a.replace and a.done else None
    r = paperdata.merge_blocks(ws, data, done=a.done, replace_pages=replace)
    out(f"paper.json：新增 {r['new']} 块，替换 {r['updated']} 块；已完成页 {r['done_pages']}")


def cmd_discuss(a):
    ws = find(a.id)
    if a.delete:
        out(f"删除 {paperdata.delete_discussion(ws, a.delete)} 条")
        return
    items = json.loads(Path(a.from_file).read_text(encoding="utf-8"))
    n_new, n_upd = paperdata.add_discussion(ws, items)
    out(f"讨论：新增 {n_new} 条，更新 {n_upd} 条。页面几秒内自动出现。")


def cmd_check(a):
    r = check(find(a.id))
    out(f"块 {r['blocks']} 个；公式 {r['tex']} 处；未完成页 {r['missing_pages'] or '无'}")
    if r["problems"]:
        out("问题：\n" + "\n".join(f"- {p}" for p in r["problems"]))
        sys.exit(1)
    out("检查通过")


def cmd_locate(a):
    layout = pdfwork.locate(find(a.id).root)
    out(f"定位 {len(layout)} 个块")


def cmd_export(a):
    from .build import build
    out(str(build(find(a.id))))


def cmd_demo(a):
    from .site import build_demo
    out(str(build_demo(find(a.id), Path(a.out), credit=a.credit or "")))


def cmd_merge(a):
    data = json.loads(Path(a.from_file).read_text(encoding="utf-8"))
    ops = data.get("ops") if isinstance(data, dict) else data
    r = find(a.id).apply_reader_ops(ops or [], client="merge")
    out(f"并入 {len(r['applied'])} 个操作")


def cmd_migrate(a):
    ws = migrate_folder(Path(a.folder), lib())
    out(f"已搬入文献库：{ws.id}（{ws.root}）")


def main(argv=None):
    if sys.stdout is None:  # pythonw 启动时没有控制台
        import os
        sys.stdout = sys.stderr = open(os.devnull, "w", encoding="utf-8")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="easyread", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("serve"); p.add_argument("--open", action="store_true"); p.add_argument("--port", type=int)
    p.add_argument("--exit-on-close", action="store_true", help="最后一个网页关闭后自动暂停任务并退出")
    p.set_defaults(fn=cmd_serve)
    p = sub.add_parser("stop"); p.set_defaults(fn=cmd_stop)
    p = sub.add_parser("list"); p.set_defaults(fn=cmd_list)
    p = sub.add_parser("import"); p.add_argument("source"); p.add_argument("--no-translate", action="store_true"); p.set_defaults(fn=cmd_import)
    p = sub.add_parser("translate"); p.add_argument("id"); p.add_argument("--pages"); p.set_defaults(fn=cmd_translate)
    for name, fn in (("status", cmd_status), ("check", cmd_check), ("locate", cmd_locate), ("export", cmd_export)):
        p = sub.add_parser(name); p.add_argument("id"); p.set_defaults(fn=fn)
    p = sub.add_parser("blocks"); p.add_argument("id"); p.add_argument("--from", dest="from_file", required=True)
    p.add_argument("--done"); p.add_argument("--replace", action="store_true"); p.set_defaults(fn=cmd_blocks)
    p = sub.add_parser("discuss"); p.add_argument("id"); p.add_argument("--from", dest="from_file"); p.add_argument("--delete")
    p.set_defaults(fn=cmd_discuss)
    p = sub.add_parser("merge"); p.add_argument("id"); p.add_argument("--from", dest="from_file", required=True); p.set_defaults(fn=cmd_merge)
    p = sub.add_parser("demo"); p.add_argument("id"); p.add_argument("--out", default="docs/demo"); p.add_argument("--credit", help="署名和许可说明")
    p.set_defaults(fn=cmd_demo)
    p = sub.add_parser("migrate"); p.add_argument("folder"); p.set_defaults(fn=cmd_migrate)
    a = ap.parse_args(argv)
    if not a.cmd:  # 直接运行 easyread：启动并打开浏览器
        a = ap.parse_args(["serve", "--open"])
    if a.cmd == "discuss" and not (a.from_file or a.delete):
        ap.error("discuss 需要 --from 或 --delete")
    a.fn(a)
