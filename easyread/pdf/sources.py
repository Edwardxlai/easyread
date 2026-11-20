"""从各种来源拿到论文 PDF 和元数据。

能认的输入：
- arXiv 编号或链接（2411.00640、arxiv.org/abs/…），以及 alphaXiv、Hugging Face Papers 等带 arXiv 编号的论文站链接
- DOI（10.xxxx/…、doi.org 链接）——查 Semantic Scholar 的开放获取 PDF，没有就退到 arXiv 版本
- OpenReview、ACL Anthology、bioRxiv / medRxiv、PubMed Central 链接
- 期刊 / 会议的论文页面——读页面里的 citation_pdf_url 等元数据（Google Scholar 和 Zotero 都认这套标签）
- PDF 直链
- 论文标题——在 Semantic Scholar 里找最匹配的一篇

本地拖进来的 PDF 也会用这里的 enrich()：从第一页找 arXiv 编号或 DOI，补上作者、年份、出处。
"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from ..server import http
from ..app.i18n import tr

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 EasyRead"
MAX_PDF = 200 * 1024 * 1024
S2 = "https://api.semanticscholar.org/graph/v1/paper/"
S2_FIELDS = "title,authors,year,venue,publicationDate,externalIds,openAccessPdf,abstract,url"

ARXIV_RE = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)(?![\d])", re.I)
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+[^\s\"<>.,;)\]])", re.I)


# 链接里带 arXiv 编号的论文站：alphaXiv、Hugging Face Papers、Papers.cool……直接去 arXiv 拿 PDF
ARXIV_MIRRORS = ("alphaxiv.org", "huggingface.co/papers", "hf.co/papers", "papers.cool/arxiv", "paperswithcode.com",
                 "arxiv-sanity", "semanticscholar.org/arxiv", "scholar.archive.org", "hjfy.top", "chatpaper", "papers.labml.ai")


class SourceError(ValueError):
    pass


# ---------- 网络 ----------
def _get(url: str, accept: str = "*/*", timeout: int = 60, limit: int = MAX_PDF) -> tuple[bytes, str, str]:
    """返回 (内容, Content-Type, 最终地址)。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en,zh;q=0.8"})
    try:
        with http.urlopen(req, timeout=timeout) as r:
            data = r.read(limit + 1)
            ctype, final = r.headers.get("Content-Type", ""), r.geturl()
    except Exception as e:  # noqa: BLE001
        raise SourceError(tr("打不开 {url}：{err}", url=url, err=e))
    if len(data) > limit:
        raise SourceError(tr("文件超过 200 MB"))
    return data, ctype, final


def _json(url: str) -> dict:
    data, _, _ = _get(url, "application/json", 30, 5_000_000)
    return json.loads(data)


def _pdf(url: str) -> bytes:
    data, _, _ = _get(url, "application/pdf,*/*", 120)
    if not data.startswith(b"%PDF"):
        raise SourceError(tr("{url} 打开的不是 PDF", url=url))
    return data


def _arxiv_pdf(aid: str) -> bytes:
    try:
        return _pdf(f"https://arxiv.org/pdf/{aid}")
    except SourceError:
        base = re.sub(r"v\d+$", "", aid)
        if base == aid:
            raise
        return _pdf(f"https://arxiv.org/pdf/{base}")  # 链接里的版本号 arXiv 上还没有（或写错了），退到最新版


def _name(url: str, fallback: str = "paper") -> str:
    name = re.sub(r"[?#&].*", "", urllib.parse.unquote(url.split("?")[0].rstrip("/").rsplit("/", 1)[-1])) or fallback
    name = re.sub(r"[^\w.\-]+", "_", name)[:80] or fallback
    return name if name.lower().endswith(".pdf") else name + ".pdf"


# ---------- 元数据 ----------
def arxiv_meta(aid: str) -> dict:
    meta = {"arxiv": f"arXiv:{aid}", "url": f"https://arxiv.org/abs/{aid}"}
    try:
        data, _, _ = _get(f"https://export.arxiv.org/api/query?id_list={aid}", timeout=30, limit=2_000_000)
        meta.update(_parse_arxiv_atom(data))
    except Exception:  # noqa: BLE001 —— 元数据拿不到不影响导入
        pass
    return meta


def _parse_arxiv_atom(xml: bytes) -> dict:
    ns = {"a": "http://www.w3.org/2005/Atom", "ax": "http://arxiv.org/schemas/atom"}
    entry = ET.fromstring(xml).find("a:entry", ns)
    if entry is None:
        return {}
    text = lambda tag: " ".join((entry.findtext(tag, "", ns) or "").split())  # noqa: E731
    authors = [" ".join((a.findtext("a:name", "", ns) or "").split()) for a in entry.findall("a:author", ns)]
    published = text("a:published")
    out = {"title_en": text("a:title"), "authors": ", ".join(authors), "abstract_en": text("a:summary"),
           "date": published[:10], "year": published[:4]}
    doi = text("ax:doi")
    if doi:
        out["doi"] = doi
    return {k: v for k, v in out.items() if v}


def _s2_meta(p: dict) -> dict:
    ext = p.get("externalIds") or {}
    meta = {
        "title_en": p.get("title") or "",
        "authors": ", ".join(a.get("name", "") for a in p.get("authors") or []),
        "year": str(p.get("year") or ""),
        "date": p.get("publicationDate") or "",
        "venue": p.get("venue") or "",
        "abstract_en": p.get("abstract") or "",
    }
    if ext.get("DOI"):
        meta["doi"] = ext["DOI"]
        meta["url"] = f"https://doi.org/{ext['DOI']}"
    if ext.get("ArXiv"):
        meta["arxiv"] = f"arXiv:{ext['ArXiv']}"
        meta.setdefault("url", f"https://arxiv.org/abs/{ext['ArXiv']}")
    meta.setdefault("url", p.get("url") or "")
    return {k: v for k, v in meta.items() if v}


def s2_lookup(key: str) -> dict | None:
    """key 形如 DOI:10.1/xx、ARXIV:2411.00640、PMCID:…、URL:…；找不到返回 None。"""
    try:
        return _json(S2 + urllib.parse.quote(key, safe=":/") + "?fields=" + S2_FIELDS)
    except Exception:  # noqa: BLE001
        return None


def s2_search_title(title: str) -> dict | None:
    try:
        d = _json(S2 + "search/match?query=" + urllib.parse.quote(title) + "&fields=" + S2_FIELDS)
        return (d.get("data") or [None])[0]
    except Exception:  # noqa: BLE001
        return None


def _from_s2(p: dict | None, what: str) -> tuple[bytes, str, dict]:
    if not p:
        raise SourceError(tr("在 Semantic Scholar 上没找到 {what}", what=what))
    meta = _s2_meta(p)
    ext = p.get("externalIds") or {}
    if ext.get("ArXiv"):  # arXiv 版最稳
        aid = ext["ArXiv"]
        return _arxiv_pdf(aid), f"{aid}.pdf", {**arxiv_meta(aid), **{k: v for k, v in meta.items() if k in ("doi", "venue")}}
    oa = (p.get("openAccessPdf") or {}).get("url")
    if oa:
        try:
            return _pdf(oa), _name(oa), meta
        except SourceError:
            data, name, page_meta = _from_page(oa)
            return data, name, {**meta, **{k: v for k, v in page_meta.items() if k not in meta}}
    raise SourceError(tr("找到了《{title}》，但没有公开的 PDF。请从出版社或学校图书馆下载后拖进来", title=meta.get("title_en", what)))


# ---------- 网页里的 PDF 链接 ----------
# content 的值按开头的引号配对：标题、作者名里常有撇号（Don't、O'Brien），不能见到另一种引号就截断
_CONTENT = r"content\s*=\s*(?:\"([^\"]*)\"|'([^']*)')"
_META_RE = re.compile(r"<meta\s+[^>]*?(?:name|property)\s*=\s*[\"']([^\"']+)[\"'][^>]*?" + _CONTENT, re.I)
_META_RE2 = re.compile(r"<meta\s+[^>]*?" + _CONTENT + r"[^>]*?(?:name|property)\s*=\s*[\"']([^\"']+)[\"']", re.I)


def _page_meta(page: str) -> dict[str, list[str]]:
    tags: dict[str, list[str]] = {}
    for k, dq, sq in _META_RE.findall(page):
        tags.setdefault(k.lower(), []).append(html.unescape(dq or sq))
    for dq, sq, k in _META_RE2.findall(page):
        tags.setdefault(k.lower(), []).append(html.unescape(dq or sq))
    return tags


def _first_last(name: str) -> str:
    """“Vaswani, Ashish” → “Ashish Vaswani”。"""
    last, sep, first = name.partition(",")
    return f"{first.strip()} {last.strip()}" if sep and first.strip() else name.strip()


def _from_page(url: str) -> tuple[bytes, str, dict]:
    data, ctype, final = _get(url, "text/html,application/pdf,*/*", 60)
    if data.startswith(b"%PDF"):
        return data, _name(final), {"url": url}
    page = data[:3_000_000].decode("utf-8", "replace")
    tags = _page_meta(page)
    first = lambda k: (tags.get(k) or [""])[0].strip()  # noqa: E731
    meta = {"title_en": first("citation_title") or first("dc.title") or first("og:title"),
            "authors": ", ".join(_first_last(a) for a in tags.get("citation_author", [])[:50]),
            "date": first("citation_publication_date") or first("citation_date") or first("dc.date"),
            "venue": first("citation_journal_title") or first("citation_conference_title"),
            "doi": first("citation_doi") or first("dc.identifier").removeprefix("doi:"),
            "url": url}
    meta["year"] = (re.search(r"(19|20)\d{2}", meta["date"] or "") or [""])[0]
    meta = {k: v for k, v in meta.items() if v}
    pdf_url = first("citation_pdf_url")
    if not pdf_url:  # 找页面里明显的 PDF 链接
        m = re.search(r"href=[\"']([^\"']+\.pdf(?:\?[^\"']*)?)[\"']", page, re.I)
        pdf_url = m.group(1) if m else ""
    if pdf_url:
        pdf_url = urllib.parse.urljoin(final, html.unescape(pdf_url))
        try:
            return _pdf(pdf_url), _name(pdf_url), meta
        except SourceError:
            pass
    if meta.get("doi"):
        return _from_s2(s2_lookup("DOI:" + meta["doi"]), meta["doi"])
    raise SourceError(tr("这个网页里没找到能下载的 PDF。可能需要登录或订阅，请下载后拖进来"))


# ---------- 入口 ----------
def fetch(ref: str) -> tuple[bytes, str, dict]:
    ref = (ref or "").strip().strip("<>")
    if not ref:
        raise SourceError(tr("填一个链接、arXiv 编号、DOI 或论文标题"))
    low = ref.lower()
    is_url = bool(re.match(r"https?://", ref, re.I))

    m = ARXIV_RE.search(ref)
    if m and (not is_url or "arxiv.org" in low or any(h in low for h in ARXIV_MIRRORS)) and (is_url or re.fullmatch(r"(arxiv:)?\s*" + re.escape(m.group(1)), ref, re.I)):
        aid = m.group(1)
        return _arxiv_pdf(aid), f"{aid}.pdf", arxiv_meta(aid)

    doi = DOI_RE.search(ref)
    if doi and (not is_url or "doi.org" in low):
        d = doi.group(1)
        p = s2_lookup("DOI:" + d)
        if p:
            return _from_s2(p, d)
        return _from_page(f"https://doi.org/{d}")

    if is_url:
        m = re.search(r"openreview\.net/(?:forum|pdf)\?id=([\w\-]+)", ref)
        if m:
            u = f"https://openreview.net/pdf?id={m.group(1)}"
            return _pdf(u), f"openreview-{m.group(1)}.pdf", {"url": f"https://openreview.net/forum?id={m.group(1)}", "venue": "OpenReview"}
        m = re.search(r"aclanthology\.org/([\w.\-]+?)(?:\.pdf)?/?$", ref)
        if m:
            u = f"https://aclanthology.org/{m.group(1)}.pdf"
            return _pdf(u), f"{m.group(1)}.pdf", {"url": f"https://aclanthology.org/{m.group(1)}/", "venue": "ACL Anthology"}
        m = re.search(r"(https?://(?:www\.)?(?:biorxiv|medrxiv)\.org/content/[\w./\-]+?)(?:\.full(?:\.pdf)?|\.abstract)?(?:[?#].*)?$", ref)
        if m:
            base = m.group(1)
            data, name, meta = _pdf(base + ".full.pdf"), _name(base), {"url": base}
            return data, name, meta
        m = re.search(r"(PMC\d+)", ref)
        if m and "ncbi.nlm.nih.gov" in low:
            return _from_s2(s2_lookup("PMCID:" + m.group(1)), m.group(1))
        try:
            return _from_page(ref)
        except SourceError:
            m = re.search(r"(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])", urllib.parse.urlparse(ref).path)
            if not m:  # 别的论文站：网页里找不到 PDF，但链接里有 arXiv 编号，就当 arXiv 论文
                raise
            return _arxiv_pdf(m.group(1)), f"{m.group(1)}.pdf", arxiv_meta(m.group(1))

    # 其余当作标题
    if len(ref) < 8:
        raise SourceError(tr("认不出来。可以填 arXiv 编号、DOI、论文链接、PDF 直链，或者完整的论文标题"))
    return _from_s2(s2_search_title(ref), f"“{ref}”")


def enrich(first_page_text: str, meta: dict, *, online: bool = True) -> dict:
    """本地 PDF：从第一页文字里找 arXiv 编号或 DOI，补全元数据。只补空着的字段。"""
    if meta.get("authors") and meta.get("year"):
        return {}
    text = first_page_text[:6000]
    m = re.search(r"arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)", text)
    d = DOI_RE.search(text)
    if not online:
        ids = {"arxiv": m.group(1) if m else "", "doi": d.group(1) if d else ""}
        return {k: v for k, v in ids.items() if v and not meta.get(k)}
    found: dict = {}
    if m:
        found = arxiv_meta(m.group(1))
    else:
        p = s2_lookup("DOI:" + d.group(1)) if d else None
        if p:
            found = _s2_meta(p)
    return {k: v for k, v in found.items() if v and not meta.get(k)}
