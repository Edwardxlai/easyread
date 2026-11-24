// Run against scripts/preview_fixture.py with the library page open.
const assert = require("node:assert/strict");

module.exports = async function checkLabelDrag(page) {
  const tag = '综述候选 "A"';
  const paper = "sample-paper";
  const row = page.locator('#list [data-id="sample-paper"]');
  const sidebar = page.locator("#side [data-paper-label]").filter({ hasText: tag });
  const labelsURL = new URL("/api/p/" + paper + "/labels", page.url()).href;
  const libraryURL = new URL("/api/library", page.url()).href;
  const library = await (await page.request.get(libraryURL)).json();
  assert.deepEqual(library.items.map(p => p.id), [paper], "Use a disposable sample library");
  const post = async (url, data) => {
    const response = await page.request.post(url, { data, headers: { "X-Token": library.token } });
    assert.equal(response.status(), 200);
  };
  await post(libraryURL + "/labels", { name: tag });
  await page.reload();
  await row.waitFor();
  const dialog = page.getByRole("dialog", { name: '将「' + tag + '」添加到《阅读样例》？' });
  const chip = row.locator(".paper-label").filter({ hasText: tag });
  let writes = 0;
  const account = request => { if (request.url() === labelsURL && request.method() === "POST") writes++; };
  page.on("request", account);
  const viewport = page.viewportSize();
  try {
    await sidebar.dragTo(row);
    await dialog.waitFor();
    assert.equal(writes, 0);
    await dialog.getByRole("button", { name: "取消" }).click();
    await page.locator(".paper-label-float").waitFor({ state: "detached" });
    assert.equal(await chip.count(), 0);
    assert.equal(writes, 0);

    await page.route(labelsURL, route => route.fulfill({ status: 400, json: { error: "fixture save error" } }), { times: 1 });
    await sidebar.dragTo(row);
    await dialog.getByRole("button", { name: "确定" }).click();
    await page.locator("#toast").filter({ hasText: "fixture save error" }).waitFor();
    await page.locator(".paper-label-float").waitFor({ state: "detached" });
    assert.equal(await chip.count(), 0);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await sidebar.dragTo(row);
    await dialog.getByRole("button", { name: "确定" }).click();
    // Observe the return flight after the paper shows its new tag.
    const motion = await page.waitForFunction(() => {
      const animation = document.querySelector(".paper-label-float")?.getAnimations()[0];
      if (!animation || !document.querySelector("#list .paper-label")) return null;
      return new DOMMatrix(animation.effect.getKeyframes().at(-1).transform).m41;
    });
    assert.ok(await motion.jsonValue() < -20);
    await page.locator(".paper-label-float").waitFor({ state: "detached" });
    await page.reload();
    await chip.waitFor();
    await sidebar.waitFor();

    const sawDuplicate = page.evaluate(() => new Promise(resolve => {
      function inspect(event) {
        if (event.target.closest('[data-label-drop="existing"]')) {
          document.removeEventListener("dragover", inspect);
          resolve(true);
        }
      }
      document.addEventListener("dragover", inspect);
      setTimeout(() => { document.removeEventListener("dragover", inspect); resolve(false); }, 8000);
    }));
    await sidebar.dragTo(row);
    assert.equal(await sawDuplicate, true);
    assert.equal(await dialog.count(), 0);
    assert.equal(writes, 2);

    await post(labelsURL, { remove: [tag] });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.locator("#libraryNavBtn").click();
    const narrowRow = await row.boundingBox();
    await sidebar.dragTo(row, { targetPosition: { x: narrowRow.width - 10, y: 22 } });
    await dialog.getByRole("button", { name: "确定" }).click();
    await chip.waitFor({ state: "attached" });
    assert.equal(await page.locator(".paper-label-float").count(), 0);
  } finally {
    page.off("request", account);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: null });
    await row.click();
  }
};
