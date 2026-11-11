"""Verify offline annotations after image/style archival fails.

Run from the repository root with `python -m tests.e2e_web_offline`.
Requires optional Playwright plus a local Chrome/Edge installation.
EASYREAD_E2E_OUTPUT can select the directory for screenshots and exported HTML.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from easyread.library.library import Library
from easyread.library.store import write_json_atomic
from easyread.weblog import snapshot
from tests.weblog.test_offline_assets import CASES, IMAGE_URL, NOTE, QUOTE, STYLE_URL, import_article

ROOT = Path(__file__).resolve().parents[1]


def run():
    output = Path(os.environ.get('EASYREAD_E2E_OUTPUT') or tempfile.mkdtemp(prefix='easyread-offline-evidence-')).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='easyread-offline-library-') as temporary:
        home = Path(temporary)
        library = Library(home / 'library')
        articles = {case: import_article(library, case) for case in CASES}
        write_json_atomic(home / 'config.json', {'engine': 'none', 'check_updates': False})
        write_json_atomic(home / 'prefs.json', {'ui': {'language': 'zh'}})
        env = {**os.environ, 'EASYREAD_HOME': str(home), 'EASYREAD_LIBRARY': str(library.root), 'EASYREAD_SYSTEM_LANG': 'zh-CN'}
        server = subprocess.Popen([sys.executable, '-m', 'easyread', 'serve', '--port', '0'], cwd=ROOT,
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            url = 'http://' + server.stdout.readline().split('http://', 1)[1].split()[0]
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=snapshot.browser_path(), headless=True)
                notes = {}
                errors = []
                for case, ws in articles.items():
                    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                    context.route('https://assets.example.invalid/**', lambda route: route.abort('failed'))
                    page = context.new_page()
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(f'{url}/read/{ws.id}')
                    page.wait_for_function('!!PR.webContentWindow?.()')
                    quote = page.evaluate('''() => {
                      const target = PR.webContentWindow().document.getElementById('target');
                      target.scrollIntoView({block:'center'});
                      const root = target.querySelector('[data-easyread-side="en"]');
                      const range = root.ownerDocument.createRange();
                      range.selectNodeContents(root);
                      const selection = root.ownerDocument.getSelection();
                      selection.removeAllRanges(); selection.addRange(range);
                      root.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
                      return selection.toString();
                    }''')
                    assert quote == QUOTE, quote
                    page.locator('#selbar.open [data-s="note"]').click()
                    textarea = page.locator('#notespanel .card textarea')
                    textarea.fill(NOTE)
                    textarea.press('Escape')
                    page.wait_for_function('PR.store.pending === 0')
                    note = next(note for note in ws.load('reader')['notes'].values() if note.get('body') == NOTE)
                    assert note['quote'] == QUOTE
                    notes[case] = note
                    response = page.request.get(f'{url}/api/p/{ws.id}/export')
                    assert response.status == 200
                    (output / f'{case}.html').write_bytes(response.body())
                    context.close()

                # Close the live backend before reopening in fresh offline contexts.
                server.terminate()
                server.wait(timeout=10)
                for case, note in notes.items():
                    context = browser.new_context(offline=True, viewport={'width': 1440, 'height': 1000})
                    page = context.new_page()
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    failed, succeeded = [], []
                    page.on('requestfailed', lambda request: failed.append(request.url))
                    page.on('response', lambda response: succeeded.append(response.url) if response.url.startswith(('http://', 'https://')) else None)
                    page.goto((output / f'{case}.html').as_uri())
                    page.wait_for_function('!!PR.webContentWindow?.()')
                    expect(page).to_have_title('Offline article ' + case + ' · EasyRead')
                    frame = page.frame_locator('#webSnapshot')
                    expect(frame.locator('#target [data-easyread-side="en"]')).to_have_text(QUOTE)
                    expect(frame.locator('article > p').last.locator('[data-easyread-side="en"]')).to_have_text('The final paragraph remains readable too.')
                    mark = frame.locator('#target mark[data-note="' + note['id'] + '"]')
                    expect(mark).to_have_text(QUOTE)
                    assert not page.evaluate('PR.quoteLost(' + json.dumps(note['id']) + ')')
                    if IMAGE_URL in CASES[case]:
                        assert frame.locator('img').evaluate('(image) => image.complete && image.naturalWidth === 0')
                    if STYLE_URL in CASES[case]:
                        expect(frame.locator('link[rel="stylesheet"]')).to_have_attribute('href', STYLE_URL)
                    page.locator('#bar [data-act="notes"]').click()
                    card = page.locator('#notespanel .card[data-note="' + note['id'] + '"]')
                    expect(card).to_contain_text(NOTE)
                    # The card must scroll from the top back to the original sentence.
                    page.evaluate('window.scrollTo({top:0, behavior:"instant"})')
                    page.wait_for_function('PR.webRect(PR.webBlockHost(' + json.dumps(note['anchor']) + ')).top > innerHeight')
                    card.click()
                    page.wait_for_function('''anchor => {
                      const rect = PR.webRect(PR.webBlockHost(anchor));
                      return rect.top >= 0 && rect.bottom <= innerHeight;
                    }''', arg=note['anchor'])
                    expect(mark).to_be_visible()
                    page.screenshot(path=str(output / f'{case}-offline-annotation.png'))
                    # A reload must re-anchor from the export and fresh DOM again.
                    page.reload()
                    page.wait_for_function('!!PR.webContentWindow?.()')
                    expect(frame.locator('#target mark[data-note="' + note['id'] + '"]')).to_have_text(QUOTE)
                    assert not page.evaluate('PR.quoteLost(' + json.dumps(note['id']) + ')')
                    assert set(CASES[case]).issubset(failed), failed
                    assert not succeeded, succeeded
                    context.close()
                assert not errors, errors
                browser.close()
                print(json.dumps({'cases': list(CASES), 'backend_stopped': True, 'fresh_offline_contexts': True,
                                  'text_readable': True, 'note_body_saved': True, 'quote_anchored': True,
                                  'note_card_navigation': True, 'reload': True, 'successful_network_responses': 0,
                                  'browser_errors': errors, 'evidence': str(output)}, ensure_ascii=False))
        finally:
            server.terminate()
            server.wait(timeout=10)
            server.stdout.close()


if __name__ == '__main__':
    run()
