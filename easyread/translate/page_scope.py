"""Select translation pages without changing the scheduling pipeline."""
import re
from ..app.i18n import tr
from ..library.store import Workspace

REFERENCE_HEADING = re.compile(r"^\s*(\d+\.?\s*)?(references|bibliography|参考文献)\s*$", re.I | re.M)  # i18n-ok

def references_page(ws: Workspace) -> int | None:
    """参考文献从哪一页开始（找单独成行的 References 标题）。找不到返回 None。"""
    n = ws.load("paper").get("meta", {}).get("page_count") or 0
    for p in range(2, n + 1):
        f = ws.root / "extract" / f"page-{p:03d}.txt"
        if f.exists() and REFERENCE_HEADING.search(f.read_text(encoding="utf-8", errors="replace")):
            return p
    return None


def scope_pages(ws: Workspace, scope: str | None) -> list[int] | None:
    """翻译范围：all 全文；body 到参考文献那页为止；range:A-B 第 A 到 B 页；first:N 前 N 页（旧写法）。返回 None 表示全文。"""
    n = ws.load("paper").get("meta", {}).get("page_count") or 0
    if scope == "body":
        ref = references_page(ws)
        return list(range(1, ref + 1)) if ref else None
    if scope and scope.startswith("range:"):
        a, _, b = scope.split(":", 1)[1].partition("-")
        start, end = sorted((int(a or 1), int(b or n)))
        lo, hi = max(1, start), min(n, end)
        if lo > hi:
            raise ValueError(tr("指定页码超出了论文范围（共 {n} 页）", n=n))
        return list(range(lo, hi + 1))
    if scope and scope.startswith("first:"):
        k = int(scope.split(":", 1)[1] or 0)
        return list(range(1, min(n, k) + 1)) if k > 0 else None
    return None


