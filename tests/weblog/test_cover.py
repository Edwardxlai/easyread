import base64
import io
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup
from PIL import Image

from easyread.library.library import Library
from easyread.weblog import cover, snapshot


def png(color, size=(600, 300)):
    output = io.BytesIO()
    Image.new('RGB', size, color).save(output, format='PNG')
    return output.getvalue()


class CoverTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.lib = Library(Path(self.temporary.name))

    def import_blog(self, head='', body=''):
        html = f'<html><head><title>A blog about inference</title>{head}</head><body><article><h1>A blog about inference</h1><p>{"Useful article text. " * 20}</p>{body}</article></body></html>'
        frozen = snapshot.freeze(BeautifulSoup(html, 'html.parser'), 'https://example.com/blog')
        with patch.object(snapshot, 'fetch', return_value=frozen):
            return self.lib.import_reference('https://example.com/blog', 'web')[0]

    def test_metadata_image_is_archived_and_preferred(self):
        def get(url, *args):
            return png('red' if url.endswith('hero.png') else 'blue'), 'image/png', url
        with patch.object(snapshot.sources, '_get', side_effect=get):
            ws = self.import_blog('<meta property="og:image" content="/hero.png">', '<img src="/body.png">')
        with patch.object(snapshot.sources, '_get', side_effect=AssertionError('Cover must use the saved snapshot')):
            summary = self.lib.summary(ws)
        self.assertEqual(summary['thumb'], f'/p/{ws.id}/{cover.COVER}')
        with Image.open(ws.root / cover.COVER) as image:
            self.assertEqual(image.size, (600, 780))
            r, g, b = image.getpixel((300, 200))
            self.assertGreater(r, g + 100)
            self.assertGreater(r, b + 100)

    def test_broken_metadata_falls_back_to_article_image(self):
        image = 'data:image/png;base64,' + base64.b64encode(png('blue')).decode()
        with patch.object(snapshot.Assets, 'get', return_value=None):
            ws = self.import_blog('<meta name="twitter:image" content="data:image/png;base64,broken">', f'<img src="{image}">')
        self.lib.summary(ws)
        with Image.open(ws.root / cover.COVER) as image:
            r, g, b = image.getpixel((300, 200))
            self.assertGreater(b, r + 100)

    def test_existing_text_article_backfills_once_and_keeps_reader_data(self):
        with patch.object(snapshot.Assets, 'get', return_value=None):
            ws = self.import_blog()
        ws.apply_reader_ops([{'op': 'paper_note', 'body': 'My saved note'}])
        before = {name: (ws.root / name).read_bytes() for name in ('source.html', 'paper.json', 'reader.json')}
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.lib.summary(ws), range(3)))
        self.assertTrue(all(result['thumb'].endswith(cover.COVER) for result in results))
        with Image.open(ws.root / cover.COVER) as image:
            self.assertEqual(image.size, (600, 780))
        modified = (ws.root / cover.COVER).stat().st_mtime_ns
        self.lib.summary(ws)
        self.assertEqual((ws.root / cover.COVER).stat().st_mtime_ns, modified)
        for name, data in before.items():
            self.assertEqual((ws.root / name).read_bytes(), data)
        self.assertFalse((ws.root / 'pages/page-001.webp').exists())


if __name__ == '__main__':
    unittest.main()
