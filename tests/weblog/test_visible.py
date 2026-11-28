import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.library.store import Workspace
from easyread.weblog.translation import translate_visible


class VisibleTranslationTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.ws = Workspace(Path(folder.name))
        (self.ws.root / 'paper.json').write_text(json.dumps({
            'meta': {'source_type': 'web', 'target': 'zh'}, 'blocks': [],
        }), encoding='utf-8')

    @patch('easyread.app.config.load', return_value={'engine': 'none'})
    @patch('easyread.engines.engines.run', return_value='{"0":"重新计算"}')
    def test_reuse_after_reopening(self, run, _config):
        body = {'texts': ['Recalculate', 'Recalculate']}
        self.assertEqual(translate_visible(self.ws, body), {'count': 1})
        self.assertEqual(translate_visible(Workspace(self.ws.root), body), {'count': 0})
        self.assertEqual(run.call_count, 1)
        self.assertEqual(self.ws.load('paper')['web_visible']['zh']['Recalculate'], '重新计算')

    @patch('easyread.app.config.load', return_value={'engine': 'none'})
    @patch('easyread.engines.engines.run', return_value='{}')
    def test_partial_answer_does_not_overwrite_article(self, _run, _config):
        original = self.ws.load('paper')
        with self.assertRaises(ValueError):
            translate_visible(self.ws, {'texts': ['Visible text']})
        self.assertEqual(self.ws.load('paper'), original)
