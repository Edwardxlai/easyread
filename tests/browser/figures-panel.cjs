// 在已打开论文的桌面版或阅读页上运行；只切换视图和滚动，最后恢复阅读偏好。
async page => {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const reader = page.frames().find(frame => /\/read\//.test(frame.url())) || page;
  await reader.waitForFunction(() => window.PR?.blockById && document.querySelector('#paper .blk-figure'));
  const saved = await reader.evaluate(() => ({ prefs: { ...PR.prefs }, scroll: scrollY }));
  const panel = reader.locator('#figurespanel'), list = panel.locator('.fp-list');
  const results = [];
  try {
    if (!await reader.evaluate(() => PR.side === 'figures')) await reader.locator('[data-act="figures"]').click();
    await reader.waitForFunction(() => PR.side === 'figures' && getComputedStyle(document.querySelector('#figurespanel')).transform === 'none');
    const figures = await reader.evaluate(() => PR.state.paper.blocks.filter(b => b?.type === 'figure').map(b => b.id));
    check(figures.length > 0, 'Test paper must contain processed figures');
    check(JSON.stringify(await panel.locator('.fp-card').evaluateAll(cards => cards.map(card => card.dataset.figureId))) === JSON.stringify(figures), 'Figure order or count differs from the paper');
    check(await panel.locator('[data-key], [id^="b-"]').count() === 0, 'Panel duplicates annotation anchors');
    await reader.waitForFunction(() => { const img = document.querySelector('.fp-card .media-image img'); return img?.complete && img.naturalWidth > 0; });
    check(await panel.locator('.fp-text-label').count() > 0, 'Figure text is missing');
    results.push('figure order, images, captions, image text and unique anchors');

    const box = await list.boundingBox(), leftBefore = await reader.evaluate(() => scrollY);
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(200, box.height / 2));
    await page.mouse.wheel(0, 750);
    await reader.waitForFunction(() => document.querySelector('.fp-list').scrollTop > 0);
    check(Math.abs(await reader.evaluate(() => scrollY) - leftBefore) < 2, 'Right scrolling moved the paper');
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(250);
    check(Math.abs(await reader.evaluate(() => scrollY) - leftBefore) < 2, 'Right scroll chained into the paper at the bottom');
    const rightBefore = await list.evaluate(el => el.scrollTop);
    const bar = await reader.locator('#bar').boundingBox();
    await page.mouse.move(bar.x + 120, bar.y + bar.height + 150);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(250);
    check(await reader.evaluate(() => scrollY) !== leftBefore, 'Paper did not scroll');
    check(await list.evaluate(el => el.scrollTop) === rightBefore, 'Paper scrolling moved the figures');
    results.push('independent wheel scrolling in both directions and no scroll chaining');

    for (const view of ['original', 'translation', 'both']) {
      await reader.locator('#bar [data-view="' + view + '"]').click();
      const visible = await panel.locator('.fp-text .fp-bilingual').first().evaluate(el => ({
        original: getComputedStyle(el.querySelector('.fp-original')).display !== 'none',
        translation: getComputedStyle(el.querySelector('.fp-translation')).display !== 'none',
      }));
      check(visible.original === (view !== 'translation') && visible.translation === (view !== 'original'), 'Figure language differs from ' + view);
    }
    check(await panel.locator('.katex').count() > 0, 'Figure equations were not rendered');
    results.push('original, translation, bilingual text and math');

    for (const name of ['pages', 'notes', 'chat']) {
      await reader.locator('[data-act="' + name + '"]').click();
      check(await reader.evaluate(name => PR.side === name && document.querySelector('#figurespanel').inert, name), 'Panel switching failed for ' + name);
      await reader.locator('[data-act="figures"]').click();
      check(await reader.locator('[data-act="figures"]').getAttribute('aria-pressed') === 'true', 'Figure button is not selected');
    }
    await list.evaluate(el => { el.scrollTop = 300; });
    await panel.locator('[data-fp-close]').click();
    check(await reader.evaluate(() => PR.side === null && document.querySelector('#figurespanel').inert), 'Figure close did not release the side panel');
    check(await reader.evaluate(() => !document.querySelector('#figurespanel').contains(document.activeElement)), 'Keyboard focus stayed inside the closed panel');
    await reader.locator('[data-act="figures"]').click();
    check(await list.evaluate(el => el.scrollTop) === 300, 'Reopening reset figure scroll');
    results.push('PDF, notes, chat, close, reopen and retained figure scroll');

    await list.evaluate(el => { el.scrollTop = 0; });
    await panel.locator('.media-image img').first().click();
    await reader.locator('.figure-viewer[open]').waitFor();
    await page.keyboard.press('Escape');
    check(await reader.locator('.figure-viewer[open]').count() === 0, 'Image zoom did not close');
    await panel.locator('[data-media-go]').first().click();
    await page.waitForTimeout(1200);
    check(await reader.evaluate(() => PR.side === 'figures'), 'Locating a figure closed the panel');
    results.push('existing full-size image viewer and locate-in-paper navigation');
    return { figures: figures.length, passed: results };
  } finally {
    await reader.evaluate(saved => {
      Object.assign(PR.prefs, saved.prefs);
      PR.applyPrefs();
      window.scrollTo(0, saved.scroll);
    }, saved);
    await reader.waitForFunction(() => PR.store.pending === 0);
  }
}
