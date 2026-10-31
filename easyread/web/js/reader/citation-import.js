/* Import a cited paper using the regular PDF import path, then remember the
   reader's explicit association with the unchanged bibliography entry. */
(function (PR) {
  'use strict';
  let dialog, current = null, importing = false;
  const E = PR.esc;
  const $ = sel => dialog.querySelector(sel);
  function create() {
    dialog = document.createElement('div');
    dialog.className = 'dialog-backdrop';
    document.body.appendChild(dialog);
    dialog.addEventListener('click', e => {
      if (e.target === dialog || e.target.closest('[data-ci-close]')) { dialog.classList.remove('open'); return; }
      if (e.target.closest('[data-ci-add]')) start();
      if (e.target.closest('[data-ci-file]')) $('[data-ci-pdf]').click();
      const open = e.target.closest('[data-ci-open]');
      if (open) PR.citationNav.go('/read/' + encodeURIComponent(open.dataset.ciOpen));
    });
    dialog.addEventListener('change', e => { if (e.target.matches('[data-ci-pdf]') && e.target.files[0]) start(e.target.files[0]); });
    dialog.addEventListener('keydown', e => { if (e.key === 'Escape') dialog.classList.remove('open'); });
  }
  PR.importCitation = async function (paper, ref) {
    if (importing) { PR.toast(PR.t('一篇论文正在导入，请稍候。')); return; }
    if (!dialog) create();
    try {
      const data = await PR.api('/api/p/' + encodeURIComponent(paper) + '/citations');
      const entry = data.references.find(r => r.id === ref);
      if (!entry) throw new Error(PR.t('参考文献已变化，请重新选择条目'));
      current = {paper, entry};
      dialog.innerHTML = '<div class="dialog citation-import" role="dialog" aria-modal="true" aria-labelledby="citationImportTitle">' +
        '<h2 id="citationImportTitle">' + PR.t('加入文献库') + '</h2><p class="citation-import-ref">' + E(entry.text) + '</p>' +
        '<p class="hint">' + PR.t('用 DOI、arXiv 编号或论文链接查找 PDF；也可以选择已下载的 PDF。加入后先准备原页，不自动调用模型。') + ' <a href="https://scholar.google.com/scholar?q=' + encodeURIComponent(entry.text.slice(0, 300)) + '" target="_blank" rel="noopener noreferrer">' + PR.t('搜索论文') + '</a></p>' +
        '<label class="field"><span>' + PR.t('论文链接、DOI 或 arXiv 编号') + '</span><input class="input" data-ci-ref value="' + E(entry.source_url || '') + '"></label>' +
        '<input type="file" accept="application/pdf,.pdf" data-ci-pdf hidden>' +
        '<p class="citation-import-status hint" role="status" data-ci-status></p>' +
        '<div class="actions"><button class="btn" data-ci-close>' + PR.t('关闭') + '</button><button class="btn line" data-ci-file>' + PR.t('选择 PDF') + '</button><button class="btn accent" data-ci-add>' + PR.t('查找并加入') + '</button></div></div>';
      dialog.classList.add('open');
      $('[data-ci-ref]').focus();
    } catch (e) { PR.toast(PR.t('无法读取引用：{msg}', {msg:E(e.message)})); }
  };
  async function start(file) {
    if (importing || !current) return;
    const ref = $('[data-ci-ref]').value.trim();
    if (!file && !ref) { $('[data-ci-status]').textContent = PR.t('请填写论文链接、DOI 或 arXiv 编号，或选择 PDF。'); return; }
    const job = current, status = $('[data-ci-status]');
    importing = true;
    $('[data-ci-add]').disabled = true; $('[data-ci-file]').disabled = true;
    status.textContent = file ? PR.t('正在加入 PDF…') : PR.t('正在查找并下载 PDF…');
    let imported;
    try {
      const base = '/api/p/' + encodeURIComponent(job.paper) + '/';
      imported = file
        ? await PR.api(base + 'citation-import-pdf?name=' + encodeURIComponent(file.name) + '&ref_id=' + encodeURIComponent(job.entry.id) + '&fingerprint=' + encodeURIComponent(job.entry.fingerprint), {method:'POST', body:file})
        : await PR.api(base + 'citation-import', {method:'POST', body:{ref, ref_id:job.entry.id, fingerprint:job.entry.fingerprint}});
    } catch (e) {
      status.textContent = PR.t('未能完成或确认导入：{msg}。请检查文献库，或下载 PDF 后选择文件。', {msg:e.message});
      if (!dialog.classList.contains('open')) PR.toast(E(status.textContent), {label:PR.t('查看'), fn:() => dialog.classList.add('open')}, 8000);
      importing = false; $('[data-ci-add]').disabled = false; $('[data-ci-file]').disabled = false;
      return;
    }
    PR.refreshCitations();
    status.textContent = imported.citation_error
      ? PR.t('论文已加入文献库，但未能关联此引用：{msg}', {msg:imported.citation_error})
      : imported.new ? PR.t('已加入文献库并关联此引用，原页正在准备。') : PR.t('论文已在文献库中，已关联此引用。');
    const open = document.createElement('button');
    open.className = 'btn line'; open.dataset.ciOpen = imported.id; open.textContent = PR.t('打开论文');
    status.after(open);
    if (!dialog.classList.contains('open')) PR.toast(E(status.textContent), {label:PR.t('打开论文'), fn:() => PR.citationNav.go('/read/' + encodeURIComponent(imported.id))}, 8000);
    importing = false;
    $('[data-ci-pdf]').value = '';
  }
})(window.PR);
