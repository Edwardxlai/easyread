// Exercise the document selection and source links with an isolated Chromium profile.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const python = process.env.PYTHON || (process.platform === 'win32'
    ? path.join(root, '.venv/Scripts/python.exe') : 'python3');
  const service = spawn(python, ['-X', 'utf8', 'scripts/preview_fixture.py'], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    service.once('exit', resolve);
    service.once('error', reject);
  });
  let url, browser, page, timer;
  try {
    const lines = createInterface({ input: service.stdout });
    const listening = new Promise(resolve => lines.on('line', line => {
      const match = line.match(/EasyRead 已启动：(http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) resolve(match[1]);
    }));
    url = await Promise.race([listening, exited.then(code => {
      throw Error('Fixture exited during startup: ' + code);
    }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Fixture startup timed out')), 30000);
    })]);
    browser = await chromium.launch();
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(8000);
    await page.goto(url);
    await page.locator('#recentPaperList .empty').waitFor();
    assert.equal(await page.locator('#recentPaperList [data-paper]').count(), 0);
    const toggle = page.getByRole('button', { name: '标签', exact: true });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.press('Space');
    await page.reload();
    await page.locator('#recentPaperList .empty').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(await page.locator('#paperLabelList').evaluate(list => list.hidden));
    await page.locator('.row[data-id="sample-paper"]').click();
    await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(await page.locator('#paperLabelList').evaluate(list => !list.hidden));
    const reader = page.locator('#detail a[href^="/read/sample-paper"]');
    await Promise.all([page.waitForURL('**/read/sample-paper*'), reader.click()]);
    await page.waitForLoadState('load');
    const paragraph = page.locator('#b-p1-1 .zh');
    await paragraph.waitFor();
    await paragraph.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const quote = page.locator('[data-s="paper-note"]');
    await quote.waitFor();
    await quote.evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelector('#paperNote')?.value.includes('#b-p1-1'));
    // Wait for the server receipt before testing a fresh page with persisted data.
    await page.waitForFunction(async () => {
      const part = await (await fetch('/api/p/sample-paper/part/reader')).json();
      return part.data.paper_note?.body?.includes('#b-p1-1');
    }, null, { polling: 200 });
    await page.reload();
    const related = page.locator('[data-paper-note-source="p1-1"]');
    await related.waitFor();
    await related.evaluate(button => button.click());
    const source = page.locator('.pn-quote-controls a[href="#b-p1-1"]');
    await source.waitFor();
    await source.evaluate(link => link.click());
    assert.equal(new URL(page.url()).hash, '#b-p1-1');
    await page.goto(url);
    await page.locator('#recentPaperList [data-paper="sample-paper"]').waitFor();
    assert.equal(await page.locator('#recentPaperList .empty').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    const nav = page.locator('#libraryNavBtn');
    await nav.click();
    assert.equal(await nav.getAttribute('aria-expanded'), 'true');
    await toggle.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await nav.click();
    assert.equal(await nav.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#side').isHidden(), true);
    for (const width of [320, 768, 1147]) {
      await page.setViewportSize({ width, height: 844 });
      const fits = await page.locator('.topbar').evaluate(bar => {
        const bounds = bar.getBoundingClientRect();
        return document.documentElement.scrollWidth <= innerWidth && [...bar.children].every(element => {
          const rect = element.getBoundingClientRect();
          return !rect.width || (rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= bounds.bottom);
        });
      });
      assert.ok(fits, 'Library toolbar must fit at ' + width + 'px');
    }
    console.log('PASS: library, excerpt, server save, reload and return to source');
  } catch (error) {
    if (page) console.error(await page.locator('#notespanel').evaluateAll(nodes => nodes.map(node => ({
      body: document.body.className, panel: node.className,
      hidden: [...node.querySelectorAll('[hidden]')].map(el => el.className),
      sourceRect: node.querySelector('[data-note-mode=source]')?.getBoundingClientRect().toJSON(),
    }))));
    throw error;
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
    if (url && service.exitCode === null) {
      try {
        const { token } = await (await fetch(url + '/api/library')).json();
        const response = await fetch(url + '/api/shutdown', {
          method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'X-Token': token },
        });
        if (!response.ok) throw Error('Shutdown HTTP ' + response.status);
      } catch { service.kill(); }
    } else if (service.exitCode === null) service.kill();
    await exited;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
