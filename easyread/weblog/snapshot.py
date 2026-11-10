"""Freeze a web article's DOM without giving imported scripts access to EasyRead."""
from __future__ import annotations

import base64
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Comment, Tag

from ..pdf import sources
from .cover import image_tags

MAX_HTML = 8 * 1024 * 1024
CSP = ("default-src 'none'; style-src 'unsafe-inline' https: http:; "
       "img-src data: https: http:; font-src data: https: http:; "
       "media-src data: https: http:; base-uri 'none'; form-action 'none'; frame-src 'none'; script-src 'none'")


def browser_path():
    candidates = [shutil.which(n) for n in ('google-chrome', 'chromium', 'chromium-browser', 'msedge')]
    if sys.platform == 'darwin':
        candidates += ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                       '/Applications/Chromium.app/Contents/MacOS/Chromium']
    if os.name == 'nt':
        for base in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
            for rel in ('Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'):
                candidates.append(str(Path(os.environ.get(base, '')) / rel))
    return next((str(p) for p in candidates if p and Path(p).is_file()), None)


def render(url: str) -> str:
    browser = browser_path()
    if not browser:
        raise ValueError('这个网页需要 JavaScript 加载正文。请安装 Chrome 或 Edge 后重新导入。')
    # Separate ephemeral profile: never read cookies or change an existing browser session.
    with tempfile.TemporaryDirectory(prefix='easyread-web-') as profile:
        try:
            result = subprocess.run([browser, '--headless', '--disable-gpu', '--no-first-run',
                                     '--no-default-browser-check', f'--user-data-dir={profile}',
                                     '--dump-dom', '--timeout=25000', '--virtual-time-budget=12000', url],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=45)
        except subprocess.TimeoutExpired:
            raise ValueError('网页加载超时，请稍后重试。') from None
    if result.returncode or len(result.stdout) > MAX_HTML:
        raise ValueError('无法获取网页正文，或网页过大。')
    return result.stdout.decode('utf-8', 'replace')


def fetch(url: str):
    if urlparse(url).scheme not in ('http', 'https'):
        raise ValueError('博客导入只支持 HTTP / HTTPS 链接。')
    data, ctype, final = sources._get(url, 'text/html,application/xhtml+xml', 30, MAX_HTML)
    if 'html' not in ctype.lower() and not data.lstrip().lower().startswith((b'<!doctype html', b'<html')):
        raise ValueError('这个链接不是 HTML 网页。')
    soup = BeautifulSoup(data, 'html.parser')
    body = soup.body or soup
    if len(body.get_text(' ', strip=True)) < 160 and soup.find('script'):
        soup = BeautifulSoup(render(final), 'html.parser')
    return freeze(soup, final)


class Assets:
    """Best-effort self-contained styles/images, bounded to 32 MB per snapshot."""
    def __init__(self):
        self.cache = {}
        self.remaining = 32 * 1024 * 1024
        self.requests = 0
        self.missing = []

    def get(self, url):
        if url in self.cache:
            return self.cache[url]
        if not url.startswith(('http://', 'https://')):
            return None
        if self.requests >= 80 or self.remaining <= 0:
            self.missing.append(url)
            return None
        self.requests += 1
        self.cache[url] = None
        try:
            data, ctype, final = sources._get(url, '*/*', 8, min(self.remaining, 8 * 1024 * 1024))
            self.remaining -= len(data)
            self.cache[url] = (data, ctype.split(';')[0], final)
        except sources.SourceError:
            self.missing.append(url)
        return self.cache[url]

    def uri(self, url):
        if url.startswith('data:'):
            return url
        result = self.get(url)
        if not result:
            return url
        data, mime, _ = result
        mime = mime or mimetypes.guess_type(urlparse(url).path)[0] or 'application/octet-stream'
        return 'data:' + mime + ';base64,' + base64.b64encode(data).decode()

    def css(self, css, base, depth=0):
        def imported(m):
            url = urljoin(base, m.group(1))
            result = self.get(url) if depth < 3 else None
            return self.css(result[0].decode('utf-8', 'replace'), result[2], depth + 1) if result else m.group(0)
        css = re.sub(r'@import\s+["\']([^"\']+)["\']\s*;', imported, css)
        def resource(m):
            raw = m.group(1).strip().strip('"\'')
            if raw.startswith(('#', 'data:')):
                return m.group(0)
            url = urljoin(base, raw)
            # CSS imports via url() still resolve remotely rather than embedding CSS as a font/image.
            return 'url("' + self.uri(url).replace('"', '%22') + '")'
        return re.sub(r'url\(([^)]+)\)', resource, css)


def freeze(soup, url, *, assets=None):
    assets = assets or Assets()
    if not soup.html:
        soup = BeautifulSoup('<html><head></head><body>' + str(soup) + '</body></html>', 'html.parser')
    if not soup.head:
        soup.html.insert(0, soup.new_tag('head'))
    if not soup.body:
        raise ValueError('网页没有正文。')
    title_tag = soup.find('meta', property='og:title') or soup.find('meta', attrs={'name': 'twitter:title'})
    title = title_tag.get('content', '') if title_tag else ''
    title = title or (soup.title.get_text() if soup.title else urlparse(url).hostname)
    author = soup.find('meta', attrs={'name': 'author'})
    date = soup.find('meta', property='article:published_time')
    meta = {'title_en': title, 'url': url, 'source_type': 'web', 'source': url,
            'authors': author.get('content', '') if author else '', 'date': date.get('content', '') if date else '',
            'venue': urlparse(url).hostname, 'snapshot_external_assets': assets.missing}
    base = soup.find('base', href=True)
    base_url = urljoin(url, base['href']) if base else url
    for tag in image_tags(soup):
        if tag.get('content'):
            tag['content'] = assets.uri(urljoin(base_url, tag['content']))
    # Archive article images before optional font variants can exhaust the resource budget.
    for image in soup.find_all('img'):
        src = image.get('src') or image.get('data-src')
        if src:
            assets.get(urljoin(base_url, src))
    for el in list(soup.select('script, noscript, base, iframe, object, embed, form, template')):
        el.decompose()
    for el in list(soup.find_all('meta')):
        if el.has_attr('http-equiv'):
            el.decompose()
    for el in list(soup.find_all('link')):
        if 'stylesheet' in el.get('rel', []):
            href = urljoin(base_url, el.get('href', ''))
            result = assets.get(href)
            if result:
                style = soup.new_tag('style')
                if el.get('media'):
                    style['media'] = el['media']
                style.string = assets.css(result[0].decode('utf-8', 'replace'), result[2])
                el.replace_with(style)
            else:
                el['href'] = href
        else:
            el.decompose()
    for el in soup.find_all(True):
        for attr in list(el.attrs):
            if attr.lower().startswith('on') or attr.lower() in ('srcdoc', 'nonce', 'integrity', 'autofocus', 'contenteditable') or attr.lower().startswith('data-easyread'):
                del el[attr]
        for attr in ('href', 'src', 'poster', 'xlink:href'):
            if el.has_attr(attr):
                raw = re.sub(r'[\x00-\x20]', '', str(el[attr]))
                if raw.startswith('#'):
                    continue
                absolute = urljoin(base_url, raw)
                scheme = urlparse(absolute).scheme.lower()
                if scheme not in ('http', 'https', 'mailto', 'tel') and not (attr in ('src', 'poster') and raw.lower().startswith('data:image/')):
                    del el[attr]
                else:
                    el[attr] = absolute
        if el.name in ('img', 'source'):
            # Pick the loaded/lazy image, and avoid a srcset overriding its archived source.
            src = el.get('src') or el.get('data-src')
            if src:
                el['src'] = assets.uri(urljoin(base_url, src))
            el.attrs.pop('srcset', None)
            el.attrs.pop('loading', None)
        if el.get('poster'):
            el['poster'] = assets.uri(el['poster'])
        if el.get('style'):
            el['style'] = assets.css(el['style'], base_url)
        if el.name == 'style' and el.string:
            el.string.replace_with(assets.css(str(el.string), base_url))
        if el.name == 'a' and not el.get('href', '').startswith('#'):
            el['target'], el['rel'] = '_blank', 'noopener noreferrer'
    blocks, groups = [], {}
    scope = soup.find('article') or soup.find('main') or soup.body
    for node in list(scope.descendants):
        ancestors = list(node.parents)
        if any(p.has_attr('hidden') or p.get('aria-hidden') == 'true'
               or re.search(r'display\s*:\s*none|visibility\s*:\s*hidden', p.get('style', ''), re.I)
               for p in ancestors):
            continue
        if isinstance(node, Tag):
            if node.name == 'img' and node.get('src') and not (str(node.get('width', '')).isdigit() and int(node['width']) <= 150):
                blocks.append({'id': f'web-{len(blocks) + 1:04d}', 'type': 'figure', 'src': node['src'],
                               'caption_en': node.get('alt', ''), 'page': 1})
            elif node.name == 'pre':
                blocks.append({'id': f'web-{len(blocks) + 1:04d}', 'type': 'para',
                               'en': '```\n' + node.get_text() + '\n```', 'page': 1})
            continue
        if isinstance(node, Comment) or not str(node).strip():
            continue
        if any(p.name in ('script', 'style', 'pre', 'code', 'svg', 'math', 'nav', 'footer', 'button', 'textarea', 'select')
               or p.has_attr('hidden') or p.get('aria-hidden') == 'true' or p.get('translate') == 'no'
               or 'katex' in p.get('class', []) or 'MathJax' in p.get('class', []) for p in node.parents):
            continue
        parent = node.find_parent(re.compile(r'^h[1-6]$')) or node.find_parent(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'figcaption', 'td', 'th', 'blockquote']) or node.parent
        key = id(parent)
        if key not in groups:
            bid = f'web-{len(blocks) + 1:04d}'
            block = {'id': bid, 'type': 'heading' if re.fullmatch('h[1-6]', parent.name or '') else 'para',
                     'en': '', 'web_runs': [], 'page': 1}
            if block['type'] == 'heading':
                block['level'] = min(2, int(parent.name[1]))
            blocks.append(block)
            groups[key] = block
        block = groups[key]
        rid = block['id'] + '-r' + str(len(block['web_runs']) + 1)
        text = str(node)
        block['web_runs'].append({'id': rid, 'en': text})
        block['en'] += text
        span = soup.new_tag('span', attrs={'data-easyread-run': rid, 'style': 'display:contents'})
        span.string = text
        node.replace_with(span)
    if sum(len(b.get('en', '')) for b in blocks) < 160:
        raise ValueError('没有找到足够的博客正文；网页可能需要登录或无法在浏览器中加载。')
    # Logical batches only; never manufacture a PDF or change the blog's layout.
    page, size = 1, 0
    for block in blocks:
        if size and size + len(block.get('en', '')) > 6000:
            page, size = page + 1, 0
        block['page'] = page
        size += len(block.get('en', ''))
    meta.update(page_count=page, pages=[{'n': n} for n in range(1, page + 1)])
    csp = soup.new_tag('meta', attrs={'http-equiv': 'Content-Security-Policy', 'content': CSP})
    soup.head.insert(0, csp)
    charset = soup.new_tag('meta', attrs={'charset': 'utf-8'})
    soup.head.insert(0, charset)
    return str(soup), meta, blocks
