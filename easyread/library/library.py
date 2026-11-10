"""文献库：一个目录里放多篇论文，每篇一个子目录（目录名就是 id，取 PDF 的 SHA-256 前 12 位）。"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urldefrag, urlparse

from ..pdf import sources
from ..translate import page_check
from ..app.i18n import tr
from ..app.log import log
from .store import SCHEMA, DataReadError, Workspace, dir_lock, empty_discussion, empty_reader, now_iso, read_json, write_json_atomic



def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Library:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def ws(self, pid: str) -> Workspace | None:
        if not re.fullmatch(r"[A-Za-z0-9_\-]{4,64}", pid or ""):
            return None
        p = self.root / pid
        return Workspace(p) if (p / "paper.json").exists() else None

    def all(self) -> list[Workspace]:
        return [Workspace(p) for p in sorted(self.root.iterdir()) if p.is_dir() and not p.name.startswith(".") and (p / "paper.json").exists()]

    # ---------- 列表摘要 ----------
    def summary(self, ws: Workspace) -> dict:
        paper = ws.load("paper") or {}
        meta = dict(paper.get("meta", {}))
        item = ws.load("item") or {}
        meta.update({k: v for k, v in (item.get("meta_override") or {}).items() if v or k == "doi"})
        reader = ws.load("reader") or {}
        disc = ws.load("discussion") or {}
        job = ws.load("job") or {}
        tr = paper.get("translation", {})
        if tr.get("done_pages") and not tr.get("gaps_checked"):  # 旧版本误记成已译的空页改回没译（#55），每篇只查一次
            try:
                if page_check.repair_done(ws):
                    tr = (ws.load("paper") or {}).get("translation", {})
            except OSError:
                log.exception("核对已译页失败 %s", ws.id)
        notes = [n for n in reader.get("notes", {}).values() if not n.get("deleted")]
        replied = {e.get("reply_to") for e in disc.get("entries", []) if e.get("reply_to")}
        abstract = next((b.get("zh") or b.get("en") for b in paper.get("blocks", []) if b.get("role") == "abstract"), "") or meta.get("abstract_en", "")
        thumb = "pages/page-001.webp"
        if meta.get("source_type") == "web":
            from ..weblog.cover import COVER, ensure
            thumb = COVER
            try:
                ensure(ws, paper)
            except (OSError, ValueError):
                log.exception("生成网页封面失败 %s", ws.id)
        return {
            "id": ws.id, "source_type": meta.get("source_type", "pdf"),
            "title_zh": meta.get("title_zh", ""), "title_en": meta.get("title_en", ""), "short_zh": meta.get("short_zh", ""), "target": meta.get("target", ""),
            "authors": meta.get("authors", ""), "affiliation": meta.get("affiliation", ""),
            "year": meta.get("year") or _year(meta.get("date", "")), "date": meta.get("date", ""),
            "venue": meta.get("venue", ""), "arxiv": meta.get("arxiv", ""), "url": _link(meta), "doi": meta.get("doi", ""),
            "pages": meta.get("page_count", 0), "done_pages": len(tr.get("done_pages", [])), "en_pages": len(tr.get("en_pages", [])),
            "todo": _todo(meta.get("page_count", 0), tr),
            "abstract": abstract,
            "meta_override": item.get("meta_override") or {},
            "tags": item.get("tags", []), "status": item.get("status", "unread"), "starred": bool(item.get("starred")),
            "added": item.get("added", ""), "last_opened": item.get("last_opened", ""),
            "progress": (reader.get("progress") or {}).get("ratio", 0),
            "notes": len([n for n in notes if n.get("kind") != "highlight"]),
            "highlights": len([n for n in notes if n.get("kind") == "highlight"]),
            "open_questions": len([n for n in notes if n.get("kind") == "question" and n["id"] not in replied]),
            "discussions": len(disc.get("entries", [])),
            "has_paper_note": bool((reader.get("paper_note") or {}).get("body")),
            "job": {k: job.get(k) for k in ("type", "state", "message", "done", "total", "updated", "error", "failed", "scope", "read", "model", "target", "pages", "cap_check", "page_cap", "usage", "usage_total")} if job else None,
            "thumb": f"/p/{ws.id}/{thumb}" if (ws.root / thumb).exists() else "",
        }

    def list(self) -> list[dict]:
        items = []
        for ws in self.all():
            try:
                items.append(self.summary(ws))
            except DataReadError as e:
                # Keep the entry visible without treating unreadable notes as
                # empty data, and without blocking unrelated papers.
                items.append({"id": ws.id, "title_en": ws.id, "tags": [],
                              "status": "unread", "load_error": tr(
                                  "无法读取数据文件：{path}；原文件已保留，请从备份恢复或联系维护者", path=str(e.path))})
        return items

    # ---------- 导入 ----------
    def create_from_pdf(self, data: bytes, filename: str, meta: dict | None = None) -> tuple[Workspace, bool]:
        """建目录、落 PDF 和空数据文件。渲染原页、抽文字放到后台任务里做。返回 (目录, 是否新建)。"""
        if not data.startswith(b"%PDF"):
            raise ValueError(tr("不是 PDF 文件"))
        digest = sha256_bytes(data)
        return self._create_pdf(digest, filename, meta, data=data)

    def import_pdf_path(self, source: str | Path, meta: dict | None = None, *, link: bool = False) -> tuple[Workspace, bool]:
        """Import a local PDF. Duplicate imports never change existing storage."""
        if not link:
            source = Path(source).expanduser()
            return self.create_from_pdf(source.read_bytes(), source.name, meta)
        source, digest = self._linked_pdf(source)
        return self._create_pdf(digest, source.name, meta, linked=source)

    def _linked_pdf(self, source: str | Path) -> tuple[Path, str]:
        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", str(source)):
            raise ValueError(tr("链接导入只支持本地 PDF 文件"))
        path = Path(source).expanduser().resolve()
        if path.is_relative_to(self.root):
            raise ValueError(tr("链接的 PDF 必须在 EasyRead 文献库之外"))
        if not path.is_file():
            raise ValueError(tr("PDF 不存在或不可读：{path}", path=str(path)))
        try:
            return path, _pdf_digest(path)
        except OSError:
            raise ValueError(tr("PDF 不存在或不可读：{path}", path=str(path))) from None

    def convert_pdf_to_link(self, pid: str, source: str | Path, *, remove_copy: bool = False) -> Workspace:
        """Replace an equal stored PDF with an external reference."""
        ws = self.ws(pid)
        if not ws:
            raise KeyError(pid)
        source, digest = self._linked_pdf(source)
        with dir_lock(ws.root):
            paper = ws.load("paper")
            meta = paper.setdefault("meta", {})
            if digest[:12] != pid or meta.get("source_sha256") != digest:
                raise ValueError(tr("PDF 内容不同，不能转换为链接"))
            copied = ws.root / "source.pdf"
            if copied.is_symlink():
                raise ValueError(tr("只支持转换文献库中的普通 PDF 副本"))
            if copied.exists() and (not copied.is_file() or _pdf_digest(copied) != digest):
                raise ValueError(tr("PDF 内容不同，不能转换为链接"))
            if copied.exists() and not remove_copy:
                raise ValueError(tr("转换为链接需要明确允许删除文献库中的 PDF 副本"))
            if not copied.exists() and not meta.get("source_pdf_path"):
                raise ValueError(tr("只支持转换文献库中的普通 PDF 副本"))
            meta["source_pdf_path"] = str(source)
            write_json_atomic(ws.paper_path, paper)
            copied.unlink(missing_ok=True)
        return ws

    def _create_pdf(self, digest: str, filename: str, meta: dict | None, *, data: bytes | None = None,
                    linked: Path | None = None) -> tuple[Workspace, bool]:
        pid = digest[:12]
        ws = Workspace(self.root / pid)
        if (ws.root / "paper.json").exists():
            return ws, False
        ws.root.mkdir(parents=True, exist_ok=True)
        if linked is None:
            (ws.root / "source.pdf").write_bytes(data)
        base_meta = {"title_zh": "", "title_en": "", "authors": "", "source": filename, "source_sha256": digest, "pdf": "source.pdf"}
        base_meta.update(meta or {})
        base_meta.update(source_sha256=digest, pdf="source.pdf")
        base_meta.pop("source_pdf_path", None)
        if linked is not None:
            base_meta["source_pdf_path"] = str(linked)
        if not base_meta.get("title_en"):
            base_meta["title_en"] = _pdf_title(linked or ws.root / "source.pdf") or Path(filename).stem
        write_json_atomic(ws.paper_path, {
            "schema": SCHEMA, "meta": base_meta,
            "translation": {"scope": "未开始", "done_pages": [], "note": ""},  # i18n-ok 存进 paper.json
            "glossary": [], "references": [], "blocks": [],
        })
        write_json_atomic(ws.discussion_path, empty_discussion())
        write_json_atomic(ws.reader_path, empty_reader())
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "unread", "starred": False})
        return ws, True

    def import_reference(self, ref: str, kind: str = "auto") -> tuple[Workspace, bool]:
        """Keep scholarly/PDF resolution; fall back to a frozen web article for ordinary URLs."""
        from ..weblog import snapshot
        ref = (ref or "").strip().strip("<>")
        if kind not in ("auto", "web", "pdf"):
            raise ValueError("Unknown import type")
        canonical = urldefrag(ref)[0]
        digest = sha256_bytes(("web:" + canonical).encode())
        if kind != "pdf":
            existing = self.ws(digest[:12])
            if existing and existing.load("paper").get("meta", {}).get("source_type") == "web":
                return existing, False
        if kind != "web":
            try:
                data, name, meta = self.fetch(ref)
                return self.create_from_pdf(data, name, meta)
            except sources.SourceError:
                parsed = urlparse(ref)
                scholarly = parsed.hostname in ("arxiv.org", "www.arxiv.org", "doi.org", "openreview.net", "aclanthology.org")
                if kind == "pdf" or parsed.scheme not in ("http", "https") or scholarly or parsed.path.lower().endswith(".pdf"):
                    raise
        ws = self.ws(digest[:12])
        if ws:
            return ws, False
        html, meta, blocks = snapshot.fetch(canonical)
        ws = Workspace(self.root / digest[:12])
        ws.root.mkdir(parents=True, exist_ok=True)
        with dir_lock(ws.root):
            if ws.paper_path.exists():
                return ws, False
            (ws.root / "source.html").write_text(html, encoding="utf-8")
            # Reader figures use the same local image routes and offline-export machinery as PDFs.
            for block in blocks:
                src = block.get("src", "")
                if src.startswith("data:image/") and ";base64," in src:
                    header, payload = src.split(",", 1)
                    ext = {"image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}.get(header[5:].split(";")[0], ".img")
                    relative = "figures/" + block["id"] + ext
                    (ws.root / "figures").mkdir(exist_ok=True)
                    (ws.root / relative).write_bytes(base64.b64decode(payload))
                    block["src"] = relative
            meta["source_sha256"] = digest
            write_json_atomic(ws.discussion_path, empty_discussion())
            write_json_atomic(ws.reader_path, empty_reader())
            write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "unread", "starred": False})
            write_json_atomic(ws.paper_path, {
                "schema": SCHEMA, "meta": meta, "blocks": blocks, "glossary": [], "references": [],
                "translation": {"done_pages": list(range(1, meta["page_count"] + 1)),
                                "en_pages": list(range(1, meta["page_count"] + 1)), "gaps_checked": True}})
        return ws, True

    def fetch(self, ref: str) -> tuple[bytes, str, dict]:
        """链接、arXiv 编号、DOI、标题 → (PDF, 文件名, 元数据)。见 sources.py。"""
        try:
            return sources.fetch(ref)
        except sources.SourceError as e:
            log.warning("导入失败 %s：%s", ref[:200], e)  # 用户说“某个链接导不进来”时能查到原因
            raise

    def trash(self, pid: str) -> Path:
        ws = self.ws(pid)
        if not ws:
            raise KeyError(pid)
        dest = self.root / ".trash" / f"{pid}-{datetime.now():%Y%m%d%H%M%S}"
        dest.parent.mkdir(exist_ok=True)
        # 只整体改名，不用 shutil.move：改名失败时它会退回“复制再删”，删到一半出错就剩半个目录。
        # 刚取消的翻译要零点几秒才停下（Claude Code 进程的工作目录就在这里），多等几次
        for attempt in range(20):
            try:
                ws.root.rename(dest)
                return dest
            except PermissionError:
                if attempt == 19:
                    raise ValueError(tr("这篇论文的文件还被占用着（可能正在翻译或生成图片），等几秒再删")) from None
                time.sleep(0.25)
        return dest

    def find_by_sha(self, digest: str) -> Workspace | None:
        return self.ws(digest[:12])


def _todo(total: int, tr: dict) -> str:
    """还没译的页，写成 "3-5,9"（选页翻译用）。只读原文整理过、没译的页也算没译。"""
    done = set(tr.get("done_pages", [])) - set(tr.get("en_pages", []))
    out = []
    for n in range(1, (total or 0) + 1):
        if n in done:
            continue
        if out and out[-1][1] == n - 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in out)


def _year(date: str) -> str:
    m = re.search(r"(19|20)\d{2}", date or "")
    return m.group(0) if m else ""


def _pdf_title(path: Path) -> str:
    try:
        import pypdf
        t = (pypdf.PdfReader(str(path)).metadata or {}).get("/Title", "") or ""
        return str(t).strip()
    except Exception:  # noqa: BLE001
        return ""


def _pdf_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        header = stream.read(4)
        if header != b"%PDF":
            raise ValueError(tr("不是 PDF 文件"))
        digest.update(header)
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def migrate_folder(src: Path, lib: Library) -> Workspace:
    """把旧版技能生成的“xxx-共读”目录搬进文献库。"""
    src = Path(src)
    data = (src / "source.pdf").read_bytes()
    pid = sha256_bytes(data)[:12]
    dest = lib.root / pid
    if not dest.exists():
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("server.json", "*.html", "打开共读.cmd", ".write.lock"))  # i18n-ok 旧版文件名
    ws = Workspace(dest)
    if not ws.item_path.exists():
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "reading", "starred": False})
    reader = read_json(ws.reader_path, {}) or {}
    reader.setdefault("paper_note", {})
    write_json_atomic(ws.reader_path, reader)
    return ws



def _link(meta: dict) -> str:
    """论文主页链接：填了就用；否则由 arXiv 编号或 DOI 推出来。"""
    if meta.get("url"):
        return meta["url"]
    m = sources.ARXIV_RE.search(meta.get("arxiv") or meta.get("source") or "")
    if m and (meta.get("arxiv") or re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?\.pdf", meta.get("source") or "")):
        aid = re.sub(r"v\d+$", "", m.group(1))  # f-string 里不能有反斜杠（Python 3.10/3.11）
        return f"https://arxiv.org/abs/{aid}"
    return f"https://doi.org/{meta['doi']}" if meta.get("doi") else ""

if __name__ == "__main__":  # 调试用：打印库摘要
    import sys
    print(json.dumps(Library(Path(sys.argv[1])).list(), ensure_ascii=False, indent=1))
