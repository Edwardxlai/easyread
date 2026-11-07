import io
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import urlencode

from pypdf import PdfWriter
from easyread.library.citations import graph_for
from easyread.library.library import Library
from easyread.server.server import Handler


def pdf(width):
    out = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=width, height=80)
    writer.write(out)
    return out.getvalue()


class CitationImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Library(Path(self.tmp.name))
        self.origin, _ = self.lib.create_from_pdf(pdf(60), 'source.pdf')
        self.origin.update('paper', lambda p: p.update({'references':[{'id':'1', 'text':'A reference without an identifier.'}]}))
        self.fingerprint = graph_for(self.lib, self.origin.id)['references'][0]['fingerprint']
        self.jobs = Mock()
        self.handler = object.__new__(Handler)
        self.handler.app = types.SimpleNamespace(lib=self.lib, jobs=self.jobs)
        self.handler._json = lambda status, data: (status, data)

    def request(self, action, body, query=''):
        self.handler.path = '/api/p/' + self.origin.id + '/' + action + query
        self.handler._body = lambda: body
        return self.handler._post()

    def test_url_import_links_existing_or_new_pdf_and_reports_reverse_edge(self):
        self.lib.fetch = Mock(return_value=(pdf(70), 'paper.pdf', {'title_en':'A Target Research Paper'}))
        body = json.dumps({'ref':'https://example.org/paper', 'ref_id':'1', 'fingerprint':self.fingerprint}).encode()
        status, result = self.request('citation-import', body)
        self.assertEqual(status, 200)
        self.assertTrue(result['new'])
        self.assertNotIn('citation_error', result)
        self.assertEqual(graph_for(self.lib, self.origin.id)['references'][0]['target'], result['id'])
        self.assertEqual(graph_for(self.lib, result['id'])['cited_by'][0]['id'], self.origin.id)
        args, kwargs = self.jobs.enqueue.call_args
        self.assertEqual(args[0].id, result['id'])
        self.assertEqual(kwargs, {'translate_after':False, 'scope':None, 'read':False, 'model':'', 'translation_extra':''})
        _, again = self.request('citation-import', body)
        self.assertEqual(again['id'], result['id'])
        self.assertFalse(again['new'])

    def test_uploaded_pdf_is_linked_and_changed_reference_is_not_mislinked(self):
        query = '?' + urlencode({'name':'chosen.pdf','ref_id':'1','fingerprint':self.fingerprint})
        _, result = self.request('citation-import-pdf', pdf(75), query)
        self.assertEqual(graph_for(self.lib, self.origin.id)['references'][0]['target'], result['id'])
        self.origin.update('paper', lambda p: p['references'][0].update(text='An entirely different reference.'))
        self.assertIsNone(graph_for(self.lib, self.origin.id)['references'][0]['target'])
        _, later = self.request('citation-import-pdf', pdf(76), query)
        self.assertTrue(later['new'])
        self.assertIn('citation_error', later)
        self.assertIsNotNone(self.lib.ws(later['id']))
        self.assertIsNone(graph_for(self.lib, self.origin.id)['references'][0]['target'])


if __name__ == '__main__':
    unittest.main()
