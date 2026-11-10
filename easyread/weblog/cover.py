"""Create a local library cover from an archived article image or its title."""
from __future__ import annotations

import base64
import hashlib
import io
import os
import tempfile
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlparse

from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont, ImageOps

from ..library.store import dir_lock

COVER = 'pages/web-cover.webp'
IMAGE_META = ('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src')


def image_tags(soup):
    for name in IMAGE_META:
        yield from soup.find_all('meta', attrs={'property': name})
        yield from soup.find_all('meta', attrs={'name': name})


def font(size):
    candidates = [
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        'C:/Windows/Fonts/msyh.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def image_data(src, root):
    if src.startswith('data:image/'):
        header, payload = src.split(',', 1)
        if len(payload) > 12 * 1024 * 1024:
            return None
        return base64.b64decode(payload, validate=True) if ';base64' in header else unquote_to_bytes(payload)
    path = (root / src).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        return None
    return path.read_bytes()


def article_image(soup, paper, root):
    scope = soup.find('article') or soup.find('main') or soup
    candidates = [tag.get('content', '') for tag in image_tags(soup)]
    candidates += [tag.get('src', '') for tag in scope.find_all('img')]
    candidates += [block.get('src', '') for block in paper.get('blocks', []) if block.get('type') == 'figure']
    for src in dict.fromkeys(candidates):
        if not src or urlparse(src).scheme in ('http', 'https'):
            continue
        try:
            data = image_data(src, root)
            if not data:
                continue
            with Image.open(io.BytesIO(data)) as image:
                if image.width < 240 or image.height < 120 or image.width * image.height > 20_000_000:
                    continue
                image = ImageOps.exif_transpose(image)
                image.thumbnail((1200, 1200))
                background = Image.new('RGB', image.size, 'white')
                if image.mode in ('RGBA', 'LA') or 'transparency' in image.info:
                    image = image.convert('RGBA')
                    background.paste(image, mask=image.getchannel('A'))
                else:
                    background.paste(image.convert('RGB'))
                return background
        except (OSError, ValueError, Image.DecompressionBombError):
            continue
    return None


def lines(text, face, width, limit):
    out, line = [], ''
    for char in ' '.join(str(text).split()):
        if face.getlength(line + char) > width and line:
            head, separator, tail = line.rpartition(' ')
            out.append(head if separator and head else line.rstrip())
            line = (tail + char) if separator and head else char.lstrip()
            if len(out) == limit:
                out[-1] = out[-1][:-1] + '…'
                return out
        else:
            line += char
    if line:
        out.append(line.rstrip())
    return out


def ensure(ws, paper):
    """Backfill from local files only, with one atomic cached result per article."""
    destination = ws.root / COVER
    if destination.exists():
        return COVER
    with dir_lock(ws.root):
        if destination.exists():
            return COVER
        source = ws.root / 'source.html'
        soup = BeautifulSoup(source.read_text(encoding='utf-8'), 'html.parser') if source.exists() else BeautifulSoup('', 'html.parser')
        meta = paper.get('meta', {})
        image = article_image(soup, paper, ws.root)
        title = meta.get('title_en') or meta.get('title_zh') or (soup.title.get_text() if soup.title else '') or meta.get('url', '')
        site = urlparse(meta.get('url', '')).hostname or meta.get('venue', '')
        accent = hashlib.sha256(str(site).encode()).digest()
        color = tuple(48 + value % 96 for value in accent[:3])
        cover = Image.new('RGB', (600, 780), '#f5f3ed')
        draw = ImageDraw.Draw(cover)
        draw.rectangle((0, 0, 600, 12), fill=color)
        top = 94
        if image:
            image = ImageOps.contain(image, (552, 370))
            cover.paste(image, ((600 - image.width) // 2, 36 + (370 - image.height) // 2))
            top = 438
        face = font(38 if image else 48)
        for line in lines(title, face, 504, 5 if image else 8):
            draw.text((48, top), line, font=face, fill='#202b31')
            top += 48 if image else 60
        draw.line((48, 706, 552, 706), fill='#d3d4cd', width=2)
        draw.text((48, 726), lines(site, font(22), 504, 1)[0] if site else '', font=font(22), fill=color)
        destination.parent.mkdir(exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.web-cover-', suffix='.webp', dir=destination.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                cover.save(output, format='WEBP', quality=86)
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return COVER
