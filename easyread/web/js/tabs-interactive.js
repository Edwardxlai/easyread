(() => {
  'use strict';
  const bridge = window.easyreadInteractive;
  if (!bridge) return;
  const $ = selector => document.querySelector(selector);
  const t = (key, vars) => window.PR.t(key, vars);
  const toolbar = $('#interactiveToolbar'), pane = $('#panes');
  const status = $('#interactiveStatus'), language = $('#interactiveLanguage');
  const translate = $('#interactiveTranslate'), retry = $('#interactiveRetry');
  const tabs = new Map();
  let active, covered, paused = false;

  function coverSnapshot() {
    const entry = tabs.get(active);
    const next = !paused && entry && !entry.inline && !entry.error ? active : undefined;
    if (next === covered) return;
    if (covered) window.easyreadTabs.setSnapshotCovered(covered, false);
    covered = next;
    if (covered) window.easyreadTabs.setSnapshotCovered(covered, true);
  }

  function display() {
    const entry = tabs.get(active);
    const shown = !!entry && !paused;
    toolbar.hidden = !shown || !!entry?.inline;
    coverSnapshot();
    const frame = document.getElementById('pane-' + active);
    const rect = entry?.inline ? frame?.contentWindow.PR?.inlineWebBounds?.() : pane.getBoundingClientRect();
    return bridge.display(shown && rect ? active : null, rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(() => {});
  }

  function render() {
    const entry = tabs.get(active);
    if (!entry) return;
    coverSnapshot();
    status.textContent = entry.notice || (entry.error ? t('交互网页加载失败')
      : !entry.ready ? t('正在打开交互网页…')
      : entry.message && ['queued', 'running', 'partial', 'error', 'confirm'].includes(entry.job) ? entry.message
      : entry.count ? t('已载入 {n} 条译文', { n: entry.count }) : t('暂无译文'));
    if (entry.archiving && !entry.notice) status.textContent = t('正在保存离线资源…');
    if (entry.offline) status.textContent = (entry.missing ? t('离线 · 部分资源缺失') : t('离线')) + ' · ' + status.textContent;
    $('#interactiveArchive').hidden = !!entry.offline;
    $('#interactiveArchive').disabled = !entry.ready || entry.saving || entry.archiving;
    $('#interactiveNetwork').hidden = !entry.hasArchive;
    $('#interactiveNetwork').textContent = entry.offline ? t('切回联网') : t('打开离线网页');
    $('#interactiveVisible').disabled = !entry.ready || entry.translating;
    language.textContent = entry.translated ? t('显示原文') : t('显示译文');
    language.disabled = !entry.ready || !entry.count;
    translate.disabled = !entry.ready || ['queued', 'running'].includes(entry.job);
    retry.hidden = !entry.error;
  }

  function drop(id, switching = false) {
    clearTimeout(tabs.get(id)?.suspendTimer);
    if (!tabs.delete(id)) return Promise.resolve();
    if (!switching) void display();
    return bridge.close(id).catch(() => {});
  }

  async function open(id, mode, translated = true, inline = false) {
    const old = tabs.get(id);
    if (old) {
      if (inline === old.inline) return;
      old.inline = inline; old.translated = translated;
      render(); void display(); void bridge.language(id, translated).catch(() => {});
      return;
    }
    const entry = { translated, mode, inline };
    tabs.set(id, entry);
    render();
    void display();
    try { await bridge.open(id, mode); if (tabs.get(id) === entry) await bridge.language(id, entry.translated); }
    catch {
      if (tabs.get(id) === entry) { entry.error = true; render(); if (inline) document.getElementById('pane-' + id)?.contentWindow.PR?.inlineWebFailed?.(); }
    }
  }

  const readerFor = id => document.getElementById('pane-' + id)?.contentWindow.PR;
  async function translateLabels(id, entry) {
    if (entry.labelBusy || active !== id || !entry.translated) return;
    entry.labelBusy = true;
    try {
      while (entry.labelQueue.size && tabs.get(id) === entry && active === id && entry.translated) {
        const batch = []; let size = 0;
        for (const text of entry.labelQueue) {
          if (batch.length === 96 || size + text.length > 12000) break;
          batch.push(text); size += text.length; entry.labelQueue.delete(text);
        }
        await window.easyreadTabs.translateVisible(id,batch);
      }
    } catch (err) {
      entry.notice = err.message; if (active === id) render();
    } finally { entry.labelBusy = false; }
  }
  bridge.onLabels(({id,texts}) => {
    const entry=tabs.get(id);
    if (!entry?.translated || id!==active) return;
    entry.labelQueue ||= new Set();
    for (const t of texts) if(entry.labelQueue.size<500)entry.labelQueue.add(t);
    void translateLabels(id,entry);
  });
  bridge.onSelection(message => {
    if (message.id !== active || !tabs.get(active)?.inline) return;
    readerFor(active)?.receiveLiveSelection?.(message);
  });
  bridge.onState(value => {
    const entry = tabs.get(value.id);
    if (!entry) return;
    const notifyReady = entry.inline && value.ready && !entry.ready;
    Object.assign(entry, value);
    if (notifyReady) readerFor(value.id)?.syncLiveMarks?.(true);
    if (entry.inline && entry.error) document.getElementById('pane-' + value.id)?.contentWindow.PR?.inlineWebFailed?.();
    if (active === value.id) render();
  });
  bridge.onShortcut(event => window.easyreadTabs.keyboard({ ...event, preventDefault() {}, stopImmediatePropagation() {} }));
  language.onclick = () => {
    const entry = tabs.get(active);
    if (!entry) return;
    entry.translated = !entry.translated;
    render();
    void bridge.language(active, entry.translated).catch(() => {});
  };
  $('#interactiveSnapshot').onclick = async () => {
    const id = active;
    await drop(id);
    const reader = document.getElementById('pane-' + id)?.contentWindow.PR;
    if (reader && !reader.syncInlineWeb?.()) reader.loadWebSnapshot?.();
  };
  async function reopen(id, mode) {
    await drop(id, true);
    if (id === active) await open(id, mode);
  }
  retry.onclick = () => void reopen(active, tabs.get(active)?.mode);
  $('#interactiveNetwork').onclick = () => void reopen(active, tabs.get(active)?.offline ? 'online' : 'offline');
  $('#interactiveArchive').onclick = async () => {
    const id = active, entry = tabs.get(id);
    entry.saving = true; entry.notice = t('正在保存离线资源…'); render();
    try {
      const result = await bridge.archive(id);
      entry.notice = t('已保存 {n} 项资源，跳过 {m} 项', {n:result.count, m:result.missed});
    } catch (error) { entry.notice = error.message; }
    finally { entry.saving = false; if (id === active) render(); }
  };
  $('#interactiveVisible').onclick = async () => {
    const id = active, entry = tabs.get(id);
    entry.translating = true; entry.notice = t('正在翻译画面文字…'); render();
    try {
      const texts = await bridge.visibleTexts(id);
      const result = texts.length ? await window.easyreadTabs.translateVisible(id, texts) : {count:0};
      entry.notice = t('已补译 {n} 条画面文字', {n:result.count});
    } catch (error) { entry.notice = error.message; }
    finally { entry.translating = false; if (id === active) { render(); void display(); } }
  };
  translate.onclick = async () => {
    const id = active;
    paused = true;
    await display();
    try { await window.easyreadTabs.translateInteractive(id); }
    finally { paused = false; render(); void display(); }
  };
  new ResizeObserver(() => void display()).observe(pane);
  function scheduleRelease(id) {
    const entry = tabs.get(id);
    if (!entry || entry.suspended) return;
    clearTimeout(entry.suspendTimer);
    entry.suspendTimer = setTimeout(() => {
      if ((active === id && !document.hidden) || tabs.get(id) !== entry) return;
      if (entry.saving || entry.translating) { scheduleRelease(id); return; }
      entry.suspended = true;
      void bridge.close(id).catch(() => {});
    }, 15000);
  }
  function select(id) {
    if (active !== id) { readerFor(active)?.closeLiveSelection?.(); scheduleRelease(active); }
    active = id;
    const entry = tabs.get(id);
    clearTimeout(entry?.suspendTimer);
    if (entry?.suspended) {
      tabs.delete(id);
      void open(id, entry.mode, entry.translated, entry.inline);
    }
    document.getElementById('pane-' + id)?.contentWindow.PR?.syncInlineWeb?.();
    render(); void display();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) scheduleRelease(active);
    else select(active);
  });
  function inline(id, wanted, language) {
    const entry = tabs.get(id);
    if (entry && !entry.inline) return false;
    if (!wanted) { if (entry) void drop(id); return false; }
    if (id !== active) return true;
    if (!entry) void open(id, undefined, language, true);
    else if (entry.translated !== language) {
      entry.translated = language;
      void bridge.language(id, language).catch(() => {});
    }
    return !entry?.error;
  }
  window.easyreadLiveTabs = { open, drop, select, inline, reposition: id => { if (id === active && tabs.get(id)?.inline) void display(); } };
})();
