"""把阅读页和一篇论文打成单个 HTML：离线打开、发给别人看。

单文件里的修改存在浏览器；在页面“说明”里导出后，用 `easyread merge ID --from 导出.json` 并回文献库。
"""
from __future__ import annotations

import base64
import html as htmllib
import json
import re
from pathlib import Path

from ..app import i18n
from ..app.config import WEB
from ..library.store import Workspace

_LINK = re.compile(r'<link rel="stylesheet" href="/web/([^"]+)"\s*/?>')
_SCRIPT = re.compile(r'<script src="/web/([^"]+)"></script>')


def _data_uri(path: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def _inline_css(rel: str) -> str:
    path = WEB / rel
    css = path.read_text(encoding="utf-8")
    if "katex" in rel:  # 字体转成 data URI，离线也能显示公式
        css = re.sub(r"url\((fonts/[^)]+\.woff2)\)", lambda m: f"url({_data_uri(path.parent / m.group(1), 'font/woff2')})", css)
        css = re.sub(r",\s*url\(fonts/[^)]+\.(woff|ttf)\) format\(\"(woff|truetype)\"\)", "", css)
    return f"<style>{css}</style>"


def _script(rel: str) -> str:
    js = (WEB / rel).read_text(encoding="utf-8").replace("</script", "<\\/script")
    return f"<script>{js}</script>"


def build(ws: Workspace, out: Path | None = None, assets: Path | None = None, extra: dict | None = None, lang: str | None = None, mobile: bool = False) -> Path:
    """assets：图片不内嵌、另存到这个目录（放到网站上时页面小很多，图按需加载）；extra：额外写进页面数据的内容；lang：界面语言，默认跟当前设置。
    mobile：手机版，只读；不带 PDF 原页图（没译的页除外，正文里要用它），体积小很多。"""
    page = i18n.inject((WEB / "reader.html").read_text(encoding="utf-8"), lang)
    if mobile:
        page = page.replace("</head>", '<link rel="stylesheet" href="/web/css/reader-mobile.css">\n</head>', 1)
        page = page.replace('<script src="/web/js/reader/main.js">', '<script src="/web/js/reader/mobile.js"></script>\n<script src="/web/js/reader/main.js">', 1)
    page = _LINK.sub(lambda m: _inline_css(m.group(1)), page)
    page = _SCRIPT.sub(lambda m: _script(m.group(1)), page)
    page = page.replace('<link rel="icon" href="/web/favicon.svg">', f'<link rel="icon" href="{_data_uri(WEB / "favicon.svg", "image/svg+xml")}">')
    paper = ws.load("paper")
    images = {}
    done = set((paper.get("translation") or {}).get("done_pages") or []) if mobile else set()
    rels = [p["img"] for p in paper.get("meta", {}).get("pages", []) if p.get("n") not in done] + [b["src"] for b in paper.get("blocks", []) if b.get("src")]
    rels += [b["translated_image"]["src"] for b in paper.get("blocks", []) if (b.get("translated_image") or {}).get("src")]
    for rel in rels:
        src = ws.root / rel
        if not src.exists():
            continue
        if assets:
            dst = assets / rel.replace("/", "-")
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
            images[rel] = f"{assets.name}/{dst.name}"
        else:
            images[rel] = _data_uri(src, "image/webp")
    data = {n: ws.load(n) for n in ("discussion", "reader", "layout", "item")}
    if mobile:  # 笔记、讨论、改过的译文都带上（手机上只读）；原页定位用不上
        data["layout"] = {}
    data.update({"paper": paper, "images": images}, **(extra or {}))
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    page = page.replace("<!--PR:DATA-->", f'<script id="pr-data" type="application/json">{payload}</script>')
    title = paper.get("meta", {}).get("title_zh") or paper.get("meta", {}).get("title_en") or i18n.tr("论文")
    page = re.sub(r"<title>.*?</title>", f"<title>{htmllib.escape(title)}</title>", page, count=1)
    stem = re.sub(r'[\\/:*?"<>|]', "", paper.get("meta", {}).get("short_zh") or ws.id)
    out = out or ws.root / i18n.tr("{name}-手机版.html" if mobile else "{name}-离线版.html", name=stem)
    out.write_text(page, encoding="utf-8")
    return out
