// 在临时文献库中打开中文阅读页后，用 Playwright CLI 的 run-code --filename 运行。
async page => {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const panel = page.locator('#notespanel');
  const source = panel.locator('#paperNote');
  const rich = panel.getByRole('textbox', { name: '论文笔记富文本', exact: true });
  const menu = page.getByRole('dialog', { name: '更多工具', exact: true });
  const open = async () => {
    if (!await page.locator('body').evaluate(el => el.classList.contains('np-open'))) await page.getByRole('button', { name: '笔记', exact: true }).click();
    await page.locator('[data-np=paper]').click();
    await panel.locator('[data-note-mode=rich]').click();
  };
  const saved = async body => {
    await page.waitForFunction(value => window.PR.state.reader.paper_note.body === value, body);
    await page.waitForFunction(() => window.PR.store.pending === 0);
  };
  const setBody = async body => {
    await panel.locator('[data-note-mode=source]').click();
    await source.fill(body);
    await saved(body);
    await panel.locator('[data-note-mode=rich]').click();
  };
  const setZoom = async zoom => {
    await panel.getByRole('button', { name: '更多工具', exact: true }).click();
    await menu.getByRole('button', { name: '笔记缩放', exact: true }).click();
    await menu.getByRole('button', { name: `${zoom}%`, exact: true }).click();
  };
  await open();
  const original = await source.inputValue();
  const originalZoom = await page.evaluate(() => window.PR.ls.get('easyread-note-zoom', 100));
  const originalMap = await panel.locator('[data-note-map-toggle]').getAttribute('aria-expanded');
  const cdp = await page.context().newCDPSession(page);
  try {
    const toggleBeforeTyping = panel.locator('[data-note-map-toggle]');
    if (await toggleBeforeTyping.getAttribute('aria-expanded') === 'false') await toggleBeforeTyping.click();
    await setBody('输入测试：');
    await rich.click(); await rich.press('ControlOrMeta+End');
    await source.dispatchEvent('input');
    await cdp.send('Input.imeSetComposition', { text: 'changqi', selectionStart: 7, selectionEnd: 7 });
    await cdp.send('Input.imeSetComposition', { text: 'chang', selectionStart: 5, selectionEnd: 5 });
    // 超过自动保存的 600ms，确认预编辑拼音没有落盘。
    await page.waitForTimeout(900);
    check(await source.inputValue() === '输入测试：', 'Preedit text reached the Markdown source');
    check(await page.evaluate(() => window.PR.state.reader.paper_note.body) === '输入测试：', 'Preedit text was saved');
    check(!await panel.locator('.pn-map-svg').textContent().then(text => text.includes('chang')), 'Preedit text reached the mind map');
    await cdp.send('Input.insertText', { text: '长期' });
    await saved('输入测试：长期');

    await setZoom(150);
    check(await rich.evaluate(el => getComputedStyle(el).zoom) === '1.5', 'Note zoom was not applied');
    check(await source.inputValue() === '输入测试：长期', 'Zoom changed the note content');
    await panel.getByRole('button', { name: '更多工具', exact: true }).click();
    await menu.locator('input[type=file]').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGM0yi5kYGAAAAUVARD9xhEmAAAAAElFTkSuQmCC', 'base64') });
    await page.waitForFunction(() => document.querySelector('.pn-prose img')?.naturalWidth > 0);
    for (const type of ['paste', 'drop']) {
      await rich.evaluate(async (el, type) => {
        const blob = await (await fetch(el.querySelector('img').src)).blob();
        const data = new DataTransfer(); data.items.add(new File([blob], `${type}.png`, { type: 'image/png' }));
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(type === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, clientX: rect.x + 20, clientY: rect.y + 20, bubbles: true, cancelable: true }));
      }, type);
      await page.waitForFunction(count => document.querySelectorAll('.pn-prose img').length === count, type === 'paste' ? 2 : 3);
    }
    await saved(await source.inputValue());
    await page.reload(); await open();
    check(await rich.locator('img').count() === 3, 'Images were lost after reload');
    check(await rich.evaluate(el => getComputedStyle(el).zoom) === '1.5', 'Zoom was lost after reload');
    const toggle = panel.locator('[data-note-map-toggle]');
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.waitForFunction(() => [...document.querySelectorAll('.pn-map-svg img')].filter(img => img.naturalWidth > 0).length === 3);
    await panel.getByRole('button', { name: '更多工具', exact: true }).click();
    for (const name of ['插入图片', '插入表格', '笔记缩放']) check(await menu.getByRole('button', { name, exact: true }).locator('svg.tiptap-button-icon').count() === 1, `Missing icon: ${name}`);
    await page.keyboard.press('Escape');
    return { chineseComposition: true, imageUploadPasteDrop: true, imagesPersist: true, zoomPersists: true, mindmapThumbnails: true, menuIcons: true };
  } finally {
    if (await menu.isVisible()) await page.keyboard.press('Escape');
    await setBody(original);
    await setZoom(originalZoom);
    const toggle = panel.locator('[data-note-map-toggle]');
    if (await toggle.getAttribute('aria-expanded') !== originalMap) await toggle.click();
    await cdp.detach();
  }
}
