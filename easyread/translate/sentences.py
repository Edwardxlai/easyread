"""句子级对齐：模型在 para / list 每一项的 en 和 zh 里，于两边都断句的地方各插一个 ‖，个数相同。
并进 paper.json 前把 ‖ 去掉，记成 sents：[[英文句尾, 译文句尾], …]，按 UTF-16 计（页面上 JS 直接切），
最后一项就是两边的总长，页面拿它核对文字没被改过。对不上（个数不同、有空句）就不记，页面按整段对应。

只读原文之后补译时，英文已经定了：程序先按句号切好、插上 ‖ 发给模型，译文照着插（mark_en）。"""
from __future__ import annotations

import re

from .codeblocks import CODE, has_fence

MARK = "‖"
# Match the same four delimiters as web/js/common/markup.js, display first.
MATH_SPANS = re.compile(
    r"(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$"
    r"|(?<![\\$])\$(?!\$)((?![0-9])(?:\\\$|[^$])+?|[0-9](?:\\\$|[^$])*?(?<![\s，。；、：（(\u3400-\u9fff])(?=\$(?![0-9])))(?<!\\)\$(?!\$)"
    r"|(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]"
    r"|(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)"
)
# 句号后面跟着这些缩写不算断句（Fig. 3、et al. (2020)、e.g. the …）
_ABBR = {"e.g", "i.e", "al", "fig", "figs", "eq", "eqs", "sec", "secs", "tab", "ref", "refs", "vs", "cf", "etc", "resp",
         "approx", "no", "dr", "mr", "ms", "prof", "st", "app", "ch", "thm", "lem", "def", "prop", "cor", "viz", "ca"}


def u16(s: str) -> int:
    """JS 字符串长度（UTF-16 码元）：数学斜体这类补充平面字符算 2。"""
    return len(s.encode("utf-16-le")) // 2


def _wide(c: str) -> bool:
    """中日文字和全角标点：两句之间不加空格。韩文句间要空格，不算。"""
    o = ord(c)
    return o >= 0x2E80 and not (0xAC00 <= o <= 0xD7AF or 0x1100 <= o <= 0x11FF or 0x3130 <= o <= 0x318F)


# 句界 ‖ 前面通常是句末或分句标点；原文本来就有的 ‖（范数 ‖w‖ 写在公式外）前后贴着字母，不当句界
_BEFORE = set("‖.?!:;,)]\"'”’。？！：；，、）】」』")  # i18n-ok 标点表


def _pieces(text: str) -> list[str]:
    """按句界 ‖ 切开：公式外、前面是标点或两边都是空白的才算；公式里的和贴着字母的是范数符号，不动。"""
    out, last = [], 0
    spans = [m.span() for pattern in (CODE, MATH_SPANS) for m in pattern.finditer(text)]
    for i, c in enumerate(text):
        if c != MARK or any(a <= i < b for a, b in spans):
            continue
        before, after = text[:i].rstrip(), text[i + 1:i + 2]
        spaced = i > 0 and text[i - 1].isspace() and (not after or after.isspace())
        if (before and (before[-1] in _BEFORE or before.endswith("$"))) or spaced:
            out.append(text[last:i])
            last = i + 1
    out.append(text[last:])
    return out


def unmark(text: str) -> tuple[str, list[int] | None]:
    """去掉 ‖，返回（干净的文字，除最后一句外每句的句尾位置）。没有 ‖ 返回 None；有空句也返回 None（不算对齐）。"""
    if not isinstance(text, str) or MARK not in text:
        return text, None
    parts = _pieces(text)
    if len(parts) == 1:
        return text, None
    last = len(parts) - 1
    out, ends, empty = "", [], False
    for i, p in enumerate(parts):
        p = p.rstrip() if i == 0 else p.lstrip() if i == last else p.strip()
        if not p:
            empty = True
            continue
        if out:
            ends.append(u16(out))
            if not (_wide(out[-1]) or _wide(p[0])):
                out += " "  # 西文两句之间留一个空格，空格算下一句的开头
        out += p
    return out, None if empty or not ends else ends


def _pair(en: str, zh: str):
    """返回（干净的 en、干净的 zh、sents 或 None）。"""
    en2, ee = unmark(en)
    zh2, ze = unmark(zh)
    if has_fence(en2) or has_fence(zh2):
        return en2, zh2, None  # Sentence spans cannot wrap a <pre> block.
    if ee and ze and len(ee) == len(ze):
        return en2, zh2, [[a, b] for a, b in zip(ee, ze)] + [[u16(en2), u16(zh2)]]
    return en2, zh2, None


def _apply(obj: dict) -> None:
    en, zh, s = _pair(obj.get("en") or "", obj.get("zh") or "")
    if isinstance(obj.get("en"), str):
        obj["en"] = en
    if isinstance(obj.get("zh"), str):
        obj["zh"] = zh
    if s and obj.get("en") and obj.get("zh"):
        obj["sents"] = s
    else:
        obj.pop("sents", None)


def attach(blocks: list) -> None:
    """就地处理一批块：para 和 list 每一项记 sents，其他文字里误插的 ‖ 也去掉。并进 paper.json 前调。"""
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "para":
            _apply(b)
        elif b.get("type") == "list":
            for it in b.get("items") or []:
                if isinstance(it, dict):
                    _apply(it)
        for f in ("en", "zh", "caption_en", "caption_zh", "image_en", "image_zh"):
            if b.get("type") != "para" and isinstance(b.get(f), str):
                b[f] = unmark(b[f])[0]


def strip(text) -> str:
    return unmark(text)[0] if isinstance(text, str) else text


def valid(obj: dict) -> bool:
    """sents 还对得上这块的文字（译文被重译、术语替换改过就对不上了）。"""
    s = obj.get("sents")
    if not isinstance(s, list) or len(s) < 2 or not all(isinstance(x, list) and len(x) == 2 for x in s):
        return False
    if s[-1] != [u16(obj.get("en") or ""), u16(obj.get("zh") or "")]:
        return False
    return all(s[i][0] < s[i + 1][0] and s[i][1] < s[i + 1][1] for i in range(len(s) - 1)) and s[0][0] > 0 and s[0][1] > 0


# ---------- 英文已经定了：程序切句（补译、重译一段时用） ----------
_END = re.compile(r"[.?!][\"'”’)\]]*(?=\s+[\"'“(\[$A-Z0-9])")


def split_en(text: str) -> list[int]:
    """英文按句切，返回除最后一句外每句的句尾（Python 下标，不含后面的空格）。公式里、缩写和人名首字母后不切。"""
    if not text:
        return []
    math = [m.span() for pattern in (CODE, MATH_SPANS) for m in pattern.finditer(text)]
    ends = []
    for m in _END.finditer(text):
        i = m.start()
        if any(a <= i < b for a, b in math):
            continue
        word = re.search(r"([A-Za-z.]+)$", text[:i])
        w = (word.group(1) if word else "").lower().strip(".")
        if w in _ABBR or (word and len(word.group(1)) == 1 and word.group(1).isupper()):
            continue  # Fig. 3 / et al. / J. Smith
        if re.search(r"\d$", text[:i]) and re.match(r"\s*\d", text[m.end():]):
            continue  # 3. 5 这种小数被断行拆开
        ends.append(m.end())
    return [e for e in ends if text[e:].strip()]


def mark_en(text: str, sents=None) -> tuple[str, list[int]]:
    """给英文插上 ‖ 发给模型，返回（带 ‖ 的英文，除最后一句外每句的 UTF-16 句尾）。有 sents 就照它切，没有就程序切。"""
    if sents:
        cuts, pos16, i = [], {}, 0
        for k in range(len(text) + 1):  # UTF-16 位置 → Python 下标
            pos16[i] = k
            if k < len(text):
                i += u16(text[k])
        cuts = [pos16[e] for e, _ in sents[:-1] if e in pos16]
    else:
        cuts = split_en(text)
    out, last = "", 0
    for c in cuts:
        out += text[last:c].rstrip() + " " + MARK + " "
        last = c
        while last < len(text) and text[last].isspace():
            last += 1
    out += text[last:]
    return out, [u16(text[:c].rstrip()) for c in cuts]


def zh_sents(en: str, en_ends: list[int], zh_marked: str):
    """英文是程序切的，模型照着在译文里插 ‖：返回（干净的译文、sents 或 None）。"""
    zh, ze = unmark(zh_marked)
    if en_ends and ze and len(ze) == len(en_ends):
        return zh, [[a, b] for a, b in zip(en_ends, ze)] + [[u16(en), u16(zh)]]
    return zh, None


def mark_items(blocks: list[dict], items: dict) -> tuple[dict, dict]:
    """补译前给段落和列表项的英文插 ‖：返回（发给模型的 {键: 英文}，{键: (英文, 句尾)}）。只有一句的不插。"""
    by_id = {b.get("id"): b for b in blocks}
    out, ends = dict(items), {}
    for key, en in items.items():
        bid, _, field = key.partition("#")
        t = (by_id.get(bid) or {}).get("type")
        if isinstance(en, str) and ((t == "para" and not field) or (t == "list" and field.isdigit())):
            marked, e = mark_en(en)
            if e:
                out[key], ends[key] = marked, (en, e)
    return out, ends


def unmark_fill(zh: dict, ends: dict) -> dict:
    """补译的输出：就地去掉 ‖，返回 {键: sents}（个数对不上的键不在里面）。"""
    got = {}
    for key, v in list(zh.items()):
        if not isinstance(v, str):
            continue
        if key in ends:
            zh[key], s = zh_sents(ends[key][0], ends[key][1], v)
            if s:
                got[key] = s
        else:
            zh[key] = strip(v)
    return got
