"""Failed snapshot resources must preserve exported article text and annotations."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup

from easyread.export.build import build
from easyread.library.library import Library
from easyread.pdf.sources import SourceError
from easyread.weblog import snapshot

ARTICLE_URL = 'https://example.com/offline-article'
IMAGE_URL = 'https://assets.example.invalid/missing.png'
STYLE_URL = 'https://assets.example.invalid/missing.css'
QUOTE = 'This exact sentence stays readable and keeps its annotation when archived resources fail.'
NOTE = 'Check this sentence again while offline.'
CASES = {'image': [IMAGE_URL], 'stylesheet': [STYLE_URL], 'both': [IMAGE_URL, STYLE_URL]}


def import_article(library, case):
    resources = CASES[case]
    head = f'<link rel="stylesheet" href="{STYLE_URL}">' if STYLE_URL in resources else ''
    image = f'<img src="{IMAGE_URL}" alt="Unavailable article image">' if IMAGE_URL in resources else ''
    paragraphs = ''.join(f'<p>Paragraph {n}. ' + 'The article remains useful without its external resources. ' * 12 + '</p>' for n in range(18))
    html = f'<html><head><title>Offline article {case}</title>{head}</head><body><article><h1>Offline article {case}</h1>{image}{paragraphs}<p id="target">{QUOTE}</p><p>The final paragraph remains readable too.</p></article></body></html>'
    url = ARTICLE_URL + '/' + case

    def fetch(url, *args):
        if url in resources:
            raise SourceError('Simulated resource download failure')
        if url != ARTICLE_URL + '/' + case:
            raise AssertionError('Unexpected resource request ' + url)
        return html.encode(), 'text/html', url

    with patch.object(snapshot.sources, '_get', side_effect=fetch):
        ws, _ = library.import_reference(url, 'web')
    return ws


class OfflineAssetsTest(unittest.TestCase):
    def test_failed_resources_preserve_exported_text_and_saved_annotation(self):
        with tempfile.TemporaryDirectory() as temporary:
            library = Library(Path(temporary) / 'library')
            for case, resources in CASES.items():
                with self.subTest(case=case):
                    ws = import_article(library, case)
                    paper = ws.load('paper')
                    self.assertEqual(set(paper['meta']['snapshot_external_assets']), set(resources))
                    block = next(block for block in paper['blocks'] if block.get('en') == QUOTE)
                    ws.apply_reader_ops([{'op': 'note', 'note': {
                        'id': 'offline-note', 'anchor': block['id'], 'key': block['id'],
                        'kind': 'note', 'quote': QUOTE, 'side': 'en', 'body': NOTE,
                    }}])
                    with patch.object(snapshot.sources, '_get', side_effect=AssertionError('Export must use local files')):
                        exported = build(ws)
                    document = BeautifulSoup(exported.read_text(encoding='utf-8'), 'html.parser')
                    data = json.loads(document.find(id='pr-data').string)
                    saved = BeautifulSoup(data['web_snapshot'], 'html.parser')
                    self.assertEqual(saved.find(id='target').get_text(), QUOTE)
                    self.assertEqual(data['reader']['notes']['offline-note']['quote'], QUOTE)
                    self.assertEqual(data['reader']['notes']['offline-note']['body'], NOTE)
                    self.assertEqual(data['reader']['notes']['offline-note']['anchor'], block['id'])
                    if IMAGE_URL in resources:
                        self.assertEqual(saved.img['src'], IMAGE_URL)
                    if STYLE_URL in resources:
                        self.assertEqual(saved.find('link', rel='stylesheet')['href'], STYLE_URL)


if __name__ == '__main__':
    unittest.main()
