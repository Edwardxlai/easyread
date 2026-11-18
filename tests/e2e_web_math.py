"""Web formulas, existing highlights and standalone export in an isolated library."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from easyread.library.library import Library
from easyread.library.store import write_json_atomic
from easyread.weblog import snapshot

ROOT = Path(__file__).resolve().parents[1]
HTML = r'''<!doctype html><html><head><title>Math test</title></head><body><article>
<h1>Math test</h1><p id="example">Loss $L$ before $x^2$ and $$\frac{1}{N}$$ after.</p>
<p>This article contains explanatory text for a test of mathematical rendering. The passage describes an experiment and the corresponding results, while providing enough content for the article importer to recognize a complete readable document.</p>
</article></body></html>'''


def run():
    with tempfile.TemporaryDirectory(prefix='easyread-math-') as tmp:
        home = Path(tmp)
        lib = Library(home / 'library')
        with patch.object(snapshot.Assets, 'get', return_value=None):
            frozen = snapshot.freeze(BeautifulSoup(HTML, 'html.parser'), 'https://example.com/math')
        with patch.object(snapshot, 'fetch', return_value=frozen):
            ws, _ = lib.import_reference('https://example.com/math', 'web')
        def translate(p):
            for b in p['blocks']:
                for r in b.get('web_runs', []):
                    r['zh'] = r['en'].replace('Loss', '损失').replace('before', '之前').replace('and', '以及').replace('after', '之后')
                if b.get('web_runs'):
                    b['zh'] = ''.join(r['zh'] for r in b['web_runs'])
            p['meta']['target'] = 'zh'
        ws.update('paper', translate)
        b = next(b for b in ws.load('paper')['blocks'] if b.get('en', '').startswith('Loss'))
        old_quote = '损失 $L$ 之前'
        ws.apply_reader_ops([{'op': 'note', 'note': {'id': 'old-math', 'anchor': b['id'], 'key': b['id'],
                            'quote': old_quote, 'kind': 'highlight', 'color': 'yellow', 'updated': '2026-01-01T00:00:00Z'}}])
        write_json_atomic(home / 'config.json', {'engine': 'none', 'check_updates': False})
        env = {**os.environ, 'EASYREAD_HOME': str(home), 'EASYREAD_LIBRARY': str(lib.root), 'PYTHONUTF8': '1'}
        server = subprocess.Popen([sys.executable, '-m', 'easyread', 'serve', '--port', '0'], cwd=ROOT,
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
        try:
            url = 'http://' + server.stdout.readline().split('http://', 1)[1].split()[0]
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path=snapshot.browser_path(), headless=True)
                page = browser.new_page(viewport={'width': 1200, 'height': 900})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(f'{url}/read/{ws.id}')
                page.wait_for_function('!!PR.webContentWindow?.()')
                frame = page.frame_locator('#webSnapshot')
                def check():
                    side = frame.locator('#example [data-easyread-side="zh"]')
                    assert side.locator('.katex').count() == 3
                    assert side.locator('.katex-display').count() == 1
                    assert side.locator('.katex').first.evaluate('(e) => getComputedStyle(e).fontFamily').startswith('KaTeX')
                    assert side.locator('mark[data-note="old-math"]').count() > 0
                    assert not page.evaluate('PR.quoteLost("old-math")')
                check()
                page.locator('#bar [data-view="original"]').click()
                assert frame.locator('#example [data-easyread-side="en"] .katex').count() == 3
                page.locator('#bar [data-view="translation"]').click()
                check()
                page.reload(); page.wait_for_function('!!PR.webContentWindow?.()'); check()
                exported = page.request.get(f'{url}/api/p/{ws.id}/export').body()
                offline = home / 'offline.html'; offline.write_bytes(exported)
                page.context.set_offline(True)
                page.goto(offline.as_uri()); page.wait_for_function('!!PR.webContentWindow?.()'); check()
                assert not errors, errors
                browser.close()
                print(json.dumps({'online': True, 'language_switch': True, 'existing_highlight': True,
                                  'reload': True, 'offline': True, 'browser_errors': errors}))
        finally:
            server.terminate(); server.wait(timeout=10); server.stdout.close()


if __name__ == '__main__':
    run()
