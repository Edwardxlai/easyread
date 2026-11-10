"""Unified web reader browser regression, isolated from all user libraries.
Run: .venv/bin/python tests/e2e_web.py
Requires optional `pip install playwright` and a local Chrome/Edge installation.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright, expect

from easyread.library.library import Library
from easyread.library.store import write_json_atomic
from easyread.weblog import snapshot

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'outputs' / 'blog-unified-validation'
OUT.mkdir(parents=True, exist_ok=True)
HTML = '''<!doctype html><html><head><title>Unified blog</title><style>
body { margin:70px auto; max-width:900px; padding:0 24px; font:20px/1.8 sans-serif; color:#222 }
p { margin:30px 0 } strong { color:#285b75 } img { max-width:100% }
</style></head><body><article><h1>Unified blog</h1>
<p id="intro">Alpha <strong>bold words</strong> and <a href="/reference">linked words</a> finish here. This paragraph explains the inference system, its design, and the evidence supporting its performance claims.</p>
<p id="second">Second paragraph describes a separate experiment with a matched baseline. It keeps all conditions and qualifications in the original article for the reader to inspect.</p>
<pre><code>x = 1\nprint(x)</code></pre>
</article></body></html>'''
ZH = {
    'Unified blog': '合并后的博客阅读器', 'Alpha ': '阿尔法 ', 'bold words': '加粗词语',
    ' and ': ' 以及 ', 'linked words': '链接词语',
    ' finish here. This paragraph explains the inference system, its design, and the evidence supporting its performance claims.': ' 到此结束。这一段介绍推理系统、系统设计及其性能声明的支持证据。',
    'Second paragraph describes a separate experiment with a matched baseline. It keeps all conditions and qualifications in the original article for the reader to inspect.': '第二段介绍一个具有匹配基线的独立实验，保留原文所有条件和限定，供读者核对。',
}


def run():
    with tempfile.TemporaryDirectory(prefix='easyread-web-e2e-') as tmp:
        home = Path(tmp)
        lib = Library(home / 'library')
        with patch.object(snapshot.Assets, 'get', return_value=None):
            frozen = snapshot.freeze(BeautifulSoup(HTML, 'html.parser'), 'https://example.com/blog')
        with patch.object(snapshot, 'fetch', return_value=frozen):
            ws, _ = lib.import_reference('https://example.com/blog', 'web')
        def translated(p):
            for b in p['blocks']:
                for r in b.get('web_runs', []):
                    r['zh'] = ZH[r['en']]
                if b.get('web_runs'):
                    b['zh'] = ''.join(r['zh'] for r in b['web_runs'])
            p['meta'].update(target='zh', title_zh=ZH['Unified blog'])
            p['translation']['en_pages'] = []
        ws.update('paper', translated)
        write_json_atomic(home / 'config.json', {'engine': 'none', 'check_updates': False})
        write_json_atomic(home / 'prefs.json', {'ui': {'language': 'zh'}})
        env = {**os.environ, 'EASYREAD_HOME': str(home), 'EASYREAD_LIBRARY': str(lib.root), 'EASYREAD_SYSTEM_LANG': 'zh-CN'}
        server = subprocess.Popen([sys.executable, '-m', 'easyread', 'serve', '--port', '0'], cwd=ROOT,
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            line = server.stdout.readline()
            url = line.split('http://', 1)[1].split()[0]
            url = 'http://' + url
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path=snapshot.browser_path(), headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors, sent = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                def chat(route):
                    if route.request.method == 'GET':
                        route.fulfill(json={'threads': [], 'models': [{'id': 'test', 'engine': 'openai', 'label': 'Test', 'source': 'API', 'ready': True}], 'default': 'test'})
                    else:
                        sent.append(route.request.post_data_json)
                        route.fulfill(content_type='application/x-ndjson', body='\n'.join(json.dumps(e, ensure_ascii=False) for e in [
                            {'thread': 'test-thread', 'model': 'Test'}, {'t': '这是测试回答，引用已正确传递。'}, {'done': True, 'id': 'test-answer'}]) + '\n')
                page.route(f'**/api/p/{ws.id}/chat', chat)
                page.route('**/api/engines', lambda route: route.fulfill(json={'models': {}}))
                def boot():
                    page.goto(f'{url}/read/{ws.id}')
                    page.wait_for_function('!!PR.webContentWindow?.()')
                    page.wait_for_timeout(120)
                def saved():
                    page.wait_for_function("PR.store.mode === 'static' || PR.store.pending === 0")
                def select(start='intro', end=None, side='zh', first=0, last=None):
                    return page.evaluate('''args => {
                      const d=PR.webContentWindow().document;
                      const a=d.getElementById(args.start),b=d.getElementById(args.end||args.start);
                      a.scrollIntoView({block:'center'});
                      const nodes = el => { const roots=Array.from(el.querySelectorAll('[data-easyread-side="'+args.side+'"]'));
                        return roots.flatMap(root=>{ const w=d.createTreeWalker(root,NodeFilter.SHOW_TEXT),ns=[]; for(let n;(n=w.nextNode());) ns.push(n); return ns; }); };
                      const ns=nodes(a),ne=nodes(b),r=d.createRange();
                      r.setStart(ns[0],args.first); const tail=ne[ne.length-1]; r.setEnd(tail,args.last??tail.length);
                      d.getSelection().removeAllRanges();d.getSelection().addRange(r);
                      ns[0].parentElement.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
                      return d.getSelection().toString();
                    }''', {'start': start, 'end': end, 'side': side, 'first': first, 'last': last})
                def mark(color):
                    page.wait_for_selector('#selbar.open')
                    try:
                        page.locator('#selbar [data-color="' + color + '"]').click(timeout=5000)
                    except Exception:
                        page.screenshot(path=str(OUT / 'failure.png'))
                        print(page.evaluate('''() => {const el=document.querySelector('#selbar'),r=el.getBoundingClientRect();return {r:r.toJSON(),css:getComputedStyle(el).cssText,z:getComputedStyle(el).zIndex,classes:el.className,hit:document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2).map(e=>e.id||e.tagName),f:document.querySelector('#webSnapshot').getBoundingClientRect().toJSON()}}'''))
                        raise
                    saved()
                boot()
                frame = page.frame_locator('#webSnapshot')
                assert page.locator('#webLayoutToggle').count() == 1
                assert 'allow-scripts' not in page.locator('#webSnapshot').get_attribute('sandbox')
                assert frame.locator('#intro strong').inner_text() == '加粗词语'
                assert frame.locator('#intro a').get_attribute('href') == 'https://example.com/reference'
                initial = frame.locator('#intro').evaluate('(e)=>getComputedStyle(e).fontSize')
                quote = select()
                mark('green')
                notes = ws.load('reader')['notes']
                assert quote in [n.get('quote') for n in notes.values()], (quote, notes)
                zh_note = next(n for n in notes.values() if n['quote'] == quote)
                expect(frame.locator('#intro mark.c-green')).to_have_count(5)  # crosses strong and link nodes
                assert frame.locator('#intro strong').inner_text() == '加粗词语'
                assert frame.locator('#intro').evaluate('(e)=>getComputedStyle(e).fontSize') == initial
                # Both layouts reuse the same note ids, and layout choice survives reopening.
                page.locator('[data-web-layout="reader"]').click()
                assert page.locator('#paper').is_visible()
                assert not page.locator('#webSnapshot').is_visible()
                assert page.locator('#paper mark[data-note="' + zh_note['id'] + '"]').count()
                reader_quote = page.evaluate('''() => {
                  const el=document.querySelector('#b-'+PR.state.paper.blocks.find(b=>b.en?.startsWith('Second paragraph')).id+' .zh');
                  el.scrollIntoView({block:'center'});
                  const t=document.createTreeWalker(el,NodeFilter.SHOW_TEXT).nextNode(),r=document.createRange();
                  r.setStart(t,0);r.setEnd(t,5);getSelection().removeAllRanges();getSelection().addRange(r);
                  el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return r.toString();
                }''')
                mark('pink')
                reader_note = next(n for n in ws.load('reader')['notes'].values() if n['quote'] == reader_quote)
                page.reload()
                page.wait_for_selector('#paper .blk')
                assert page.locator('[data-web-layout="reader"]').get_attribute('aria-pressed') == 'true'
                assert not page.locator('#webSnapshot').is_visible()
                fresh = browser.new_page()
                fresh.goto(f'{url}/read/{ws.id}')
                fresh.wait_for_selector('#paper .blk')
                assert fresh.locator('[data-web-layout="reader"]').get_attribute('aria-pressed') == 'true'
                fresh.close()
                page.locator('[data-web-layout="native"]').click()
                page.wait_for_function('!!PR.webContentWindow?.()')
                assert frame.locator('mark[data-note="' + reader_note['id'] + '"]').count()
                assert frame.locator('#intro mark[data-note="' + zh_note['id'] + '"]').count()
                # Existing language controls operate on the same DOM, with side-specific quotes.
                select(last=4)
                page.locator('#bar [data-view="original"]').click()
                assert page.evaluate('PR.webContentWindow().getSelection().isCollapsed')
                en_quote = select(side='en', last=20)
                mark('blue')
                en_note = next(n for n in ws.load('reader')['notes'].values() if n['quote'] == en_quote)
                assert en_note['side'] == 'en'
                page.locator('#bar [data-view="translation"]').click()
                assert frame.locator('#intro [data-easyread-side="en"] mark.c-blue').count()
                assert not frame.locator('#intro [data-easyread-side="zh"] mark.c-blue').count()
                # Mark menu is positioned in the parent viewport, and updates use the common store.
                page.evaluate('PR.webClearSelection()')
                frame.locator('#intro mark.c-green').first.click()
                page.wait_for_selector('#popover.open')
                r = page.locator('#popover').bounding_box()
                assert r and 0 <= r['x'] < 1440 and 50 <= r['y'] < 1000
                page.locator('#popover [data-hl-color="pink"]').click(); saved()
                assert ws.load('reader')['notes'][zh_note['id']]['color'] == 'pink'
                # Cross-paragraph selection creates one note with two stable anchors.
                cross_quote = select(end='second')
                mark('yellow')
                cross = next(n for n in ws.load('reader')['notes'].values() if n.get('parts'))
                assert len(cross['parts']) == 2
                assert cross['parts'][0]['anchor'] != cross['parts'][1]['anchor']
                # Native paragraph -> note editor; the blog stays visible next to the panel.
                select(start='second', last=10)
                page.wait_for_selector('#selbar.open'); page.locator('#selbar [data-s="question"]').click()
                page.locator('#notespanel .card textarea').fill('这里的基线是否可比？')
                page.locator('#notespanel .card textarea').press('Escape'); saved()
                question = next(n for n in ws.load('reader')['notes'].values() if n.get('body') == '这里的基线是否可比？')
                assert question['kind'] == 'question'
                assert page.locator('#webSnapshot').is_visible()
                assert page.locator('#webSnapshot').bounding_box()['width'] < 1440
                # Select native text -> shared AI chat. Only the transport is stubbed, never the action/ref pipeline.
                page.locator('#notespanel [data-np-act="close"]').click()
                ai_quote = select(start='second', last=12)
                page.wait_for_selector('#selbar.open'); page.locator('#selbar [data-s="chat"]').click()
                page.wait_for_selector('#chatInput')
                page.locator('#chatInput').fill('解释这句话'); page.locator('#chatInput').press('Enter')
                page.wait_for_function("document.querySelector('#chatList').textContent.includes('引用已正确传递')")
                assert sent[-1]['refs'][0]['quote'] == ai_quote
                assert sent[-1]['refs'][0]['anchor'] == question['anchor']
                assert page.locator('#webSnapshot').is_visible()
                page.locator('#chatpanel [data-c="close"]').click()
                # Code is also selectable without translating/reformatting its contents.
                page.evaluate('''() => { const d=PR.webContentWindow().document,p=d.querySelector('pre'),t=p.querySelector('code').firstChild,r=d.createRange();p.scrollIntoView({block:'center'});
                  r.setStart(t,0);r.setEnd(t,5);d.getSelection().removeAllRanges();d.getSelection().addRange(r);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }''')
                mark('blue')
                expect(frame.locator('pre mark')).to_have_count(1)
                # Shared inline editor mounts in the native document and preserves manual edits after manuscript changes.
                page.evaluate('PR.webClearSelection()')
                frame.locator('#second').click(button='right')
                page.locator('#ctxmenu button', has_text='改译文').click()
                editor = frame.locator('[data-easyread-editor] textarea')
                editor.fill('我的自定义译文，必须保留。'); editor.press('Control+Enter'); saved()
                assert '我的自定义译文' in frame.locator('#second').inner_text()
                second_id = question['anchor']
                ws.update('paper', lambda p: next(b for b in p['blocks'] if b['id'] == second_id).update(zh='模型后来重译的版本。'))
                page.evaluate('PR.poll()')
                page.wait_for_timeout(200)
                assert '我的自定义译文' in frame.locator('#second').inner_text()
                page.screenshot(path=str(OUT / 'native-annotations.png'))
                # Reload uses the saved quote anchors, no separate reading mode or note migration.
                saved(); boot()
                expect(frame.locator('#intro mark.c-yellow').first).to_be_visible()
                expect(frame.locator('pre mark')).to_have_count(1)
                assert '我的自定义译文' in frame.locator('#second').inner_text()
                # Search can find original text and navigate inside the native DOM.
                page.keyboard.press('Control+f'); page.locator('.find-panel input').fill('matched baseline')
                page.wait_for_timeout(150)
                assert page.locator('.find-count').inner_text() != '0 / 0'
                assert page.evaluate("!!PR.webContentWindow().CSS.highlights.get('reader-find-active')?.size")
                page.locator('.find-panel [data-close]').click()
                assert not page.evaluate("PR.webContentWindow().CSS.highlights.has('reader-find-active')")
                # Offline and narrow layouts keep the same annotation UI and script isolation.
                exported = page.request.get(f'{url}/api/p/{ws.id}/export').body()
                offline = OUT / 'unified-blog.html'; offline.write_bytes(exported)
                page.goto(offline.as_uri()); page.wait_for_function('!!PR.webContentWindow?.()')
                expect(frame.locator('#intro mark.c-yellow').first).to_be_visible()
                page.locator('[data-web-layout="reader"]').click()
                assert page.locator('#paper mark[data-note="' + cross['id'] + '"]').count()
                page.locator('[data-web-layout="native"]').click()
                select(start='intro', last=3); mark('green')
                page.set_viewport_size({'width': 390, 'height': 844})
                page.locator('#bar [data-act="notes"]').click(); page.wait_for_selector('body.np-open')
                assert page.locator('#webSnapshot').is_visible()
                assert not errors, errors
                browser.close()
                print(json.dumps({'native_highlights': True, 'cross_inline_and_paragraph': True, 'original_and_translation': True,
                                  'notes_and_questions_saved': True, 'ai_reference_and_stream': True, 'code_annotations': True,
                                  'manual_edits_preserved': True, 'reload': True, 'native_search': True,
                                  'offline_and_mobile': True, 'layout_switch_and_persistence': True, 'browser_errors': errors}, ensure_ascii=False))
        finally:
            server.terminate(); server.wait(timeout=10)
            server.stdout.close()


if __name__ == '__main__':
    run()
