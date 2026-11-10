import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup

from easyread.engines import engines
from easyread.library.library import Library
from easyread.library.reader_files import prepare_later
from easyread.pdf.sources import SourceError
from easyread.translate.translate import prepare, translate_pages
from easyread.weblog import snapshot
from easyread.export.build import build

TEXT = 'This is an English blog about inference infrastructure and performance. ' * 4
HTML = f'''<!doctype html><html><head><title>A blog</title>
<link rel="stylesheet" href="/style.css"><script>evil()</script></head><body>
<nav>Navigation</nav><article><h1>A blog</h1><p class="body">{TEXT}<strong>Important</strong>
<a href="../reference">link</a></p><img src="/chart.png" alt="chart">
<pre>model.run(x)</pre><math><mi>x</mi></math><svg onload="evil()"><text>vector</text></svg>
<a href="java&#10;script:evil()" onclick="evil()">danger</a><iframe src="evil"></iframe>
<p translate="no">Do not translate</p></article></body></html>'''


class WebTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Library(Path(self.tmp.name) / 'library')
        self.asset_patch = patch.object(snapshot.Assets, 'get', return_value=None)
        self.asset_patch.start()
        self.addCleanup(self.asset_patch.stop)

    def frozen(self):
        return snapshot.freeze(BeautifulSoup(HTML, 'html.parser'), 'https://example.com/blog/post')

    def imported(self):
        with patch.object(snapshot, 'fetch', return_value=self.frozen()):
            return self.lib.import_reference('https://example.com/blog/post', 'web')[0]

    def test_structure_and_unsafe_content(self):
        html, meta, blocks = self.frozen()
        doc = BeautifulSoup(html, 'html.parser')
        self.assertEqual(meta['source_type'], 'web')
        self.assertTrue(doc.select_one('p.body strong'))
        self.assertEqual(doc.select_one('p.body a')['href'], 'https://example.com/reference')
        self.assertEqual(doc.img['src'], 'https://example.com/chart.png')
        self.assertFalse(doc.select('script, iframe, [onclick], [onload]'))
        self.assertFalse(any(a.get('href', '').startswith('java') for a in doc.find_all('a')))
        runs = ' '.join(r['en'] for b in blocks for r in b.get('web_runs', []))
        for excluded in ('Navigation', 'Do not translate', 'model.run(x)', 'vector'):
            self.assertNotIn(excluded, runs)
        self.assertTrue(any(b['type'] == 'figure' for b in blocks))
        self.assertIn('model.run(x)', html)
        self.assertTrue(doc.find('meta', attrs={'http-equiv': 'Content-Security-Policy'}))

    def test_web_import_deduplicates_and_preserves_notes(self):
        ws = self.imported()
        ws.apply_reader_ops([{'op': 'paper_note', 'body': 'my note'}])
        with patch.object(snapshot, 'fetch') as fetch:
            duplicate, fresh = self.lib.import_reference('https://example.com/blog/post#section', 'web')
        self.assertFalse(fresh)
        fetch.assert_not_called()
        self.assertEqual(duplicate.id, ws.id)
        self.assertEqual(duplicate.load('reader')['paper_note']['body'], 'my note')
        self.assertFalse((ws.root / 'source.pdf').exists())
        prepare(ws)
        with patch('easyread.library.reader_files.threading.Thread') as thread:
            prepare_later(ws)
        thread.assert_not_called()
        self.assertEqual(self.lib.summary(ws)['source_type'], 'web')

    def test_auto_fallback_keeps_pdf_path_and_rejects_non_urls(self):
        with patch.object(self.lib, 'fetch', side_effect=SourceError('no PDF')), patch.object(snapshot, 'fetch', return_value=self.frozen()) as fetch:
            ws, fresh = self.lib.import_reference('https://example.com/blog/post')
            self.assertTrue(fresh)
            self.assertEqual(ws.load('paper')['meta']['source_type'], 'web')
            for ref in ('a paper title', 'https://arxiv.org/abs/1234.56789', 'https://example.com/file.pdf'):
                with self.assertRaises(SourceError):
                    self.lib.import_reference(ref)
            self.assertEqual(fetch.call_count, 1)
        with patch.object(self.lib, 'fetch', return_value=(b'%PDF test', 'test.pdf', {})), patch.object(self.lib, 'create_from_pdf', return_value=(ws, False)) as create:
            self.lib.import_reference('https://example.com/paper')
            create.assert_called_once()

    def test_dynamic_shell_renders_before_freezing(self):
        with patch.object(snapshot.sources, '_get', return_value=(b'<html><body><div id="root"></div><script src="app.js"></script></body></html>', 'text/html', 'https://example.com/blog')), patch.object(snapshot, 'render', return_value=HTML) as render:
            html, _, blocks = snapshot.fetch('https://example.com/blog')
        render.assert_called_once()
        self.assertGreater(len(blocks), 2)

    def test_translation_is_atomic_retryable_and_keeps_dom(self):
        ws = self.imported()
        before = (ws.root / 'source.html').read_bytes()
        cfg = {'engine': 'test', 'target': 'zh'}
        runs = {r['id']: '中文译文' for b in ws.load('paper')['blocks'] for r in b.get('web_runs', []) if any(c.isalpha() for c in r['en'])}
        with patch.object(engines, 'run', side_effect=['{}', json.dumps(runs)]) as run:
            self.assertEqual(translate_pages(ws, cfg, [1], threading.Event(), lambda *a: None), {})
            self.assertEqual(run.call_count, 2)
        paper = ws.load('paper')
        self.assertEqual(paper['translation']['en_pages'], [])
        self.assertTrue(any(b.get('zh') for b in paper['blocks']))
        self.assertEqual((ws.root / 'source.html').read_bytes(), before)
        with patch.object(engines, 'run', return_value='{}'):
            self.assertIn(1, translate_pages(ws, cfg, [1], threading.Event(), lambda *a: None))
        self.assertEqual(ws.load('paper'), paper)
        cancelled = threading.Event(); cancelled.set()
        with self.assertRaises(engines.Cancelled):
            translate_pages(ws, cfg, [1], cancelled, lambda *a: None)
        with patch.object(engines, 'run') as run:
            translate_pages(ws, cfg, [1], threading.Event(), lambda *a: None, read=True)
        run.assert_not_called()

    def test_offline_export_contains_snapshot(self):
        ws = self.imported()
        exported = build(ws).read_text()
        self.assertIn('web_snapshot', exported)
        self.assertIn('webSnapshot', exported)
        self.assertNotIn('src="/web/', exported)


if __name__ == '__main__':
    unittest.main()
