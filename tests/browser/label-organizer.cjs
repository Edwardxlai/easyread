// Exercise the review UI without starting a paid model in the disposable fixture.
const assert = require('node:assert/strict');

module.exports = async function checkLabelOrganizer(page) {
  const endpoint = '**/api/library/labels/organize**';
  const paper = { id: 'sample-paper', title: '阅读样例', page: 1, quote: 'A reader can follow a quotation back to its source.' };
  const create = { id: 'new1', kind: 'create', name: '来源核查', rule: '描述回到原句核查的方法。', papers: [paper] };
  const merge = { id: 'merge1', kind: 'merge', source: '核查出处', target: '核对来源', reason: '同义且规则一致。', papers: [paper] };
  let state = { state: 'idle', phase: '', revision: 0, total: 0, done: 0, assigned: 0, proposals: [], messages: [] };
  let starts = 0, confirmations = 0, confirmed;
  await page.route(endpoint, async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      if (request.url().endsWith('/start')) {
        starts++;
        state = { ...state, id: 'fixture', done: 1, total: 1, assigned: 1, state: 'review', revision: 1, proposals: [create, merge] };
      } else if (request.url().endsWith('/feedback')) {
        assert.equal(body.message, '保留来源核查');
        assert.equal(body.revision, 1);
        state = { ...state, revision: 2, messages: [{ role: 'user', content: body.message }, { role: 'assistant', content: '保留为独立标签。' }] };
      } else if (request.url().endsWith('/confirm')) {
        confirmations++;
        confirmed = body.selected;
        assert.equal(body.revision, 2);
        state = { ...state, state: 'complete', applied: confirmed };
      }
    }
    await route.fulfill({ json: state });
  });
  try {
    await page.locator('#settingsBtn').click();
    await page.locator('[data-set-tab="library"]').click();
    await page.locator('[data-organize-labels]').click();
    const dialog = page.locator('dialog.label-organizer[open]');
    const first = dialog.locator('[data-choice="new1"]');
    await first.waitFor();
    assert.equal(await first.isChecked(), false);
    await dialog.locator('summary').first().click();
    await dialog.getByText(paper.quote, { exact: true }).first().waitFor();
    assert.equal(await dialog.locator('details a').first().getAttribute('href'), '/p/sample-paper/source.pdf#page=1');
    await first.check();
    await dialog.locator('textarea').fill('保留来源核查');
    await dialog.locator('[data-action="feedback"]').click();
    await dialog.getByText('保留为独立标签。', { exact: false }).last().waitFor();
    assert.equal(await first.isChecked(), false);
    await first.check();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.locator('[data-organize-labels]').click();
    await first.waitFor();
    assert.equal(await first.isChecked(), true);
    await dialog.locator('[data-action="confirm"]').click();
    await dialog.locator('[data-action="start"]').waitFor();
    assert.deepEqual(confirmed, ['new1']);
    assert.equal(confirmations, 1);
    await dialog.getByText('已完成整理，已应用 1 条建议。').waitFor();
    await dialog.locator('[data-close]').click();
    await page.locator('[data-organize-labels]').click();
    await dialog.locator('[data-action="start"]').waitFor();
    assert.equal(starts, 1);
    await dialog.locator('[data-close]').click();
    await page.locator('#setCancel').click();
  } finally {
    await page.unroute(endpoint);
  }
};
