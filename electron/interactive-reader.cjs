const path = require('node:path');
const archive = require('./interactive-archive.cjs');
const { createHash } = require('node:crypto');
const { webUrl, isolateSession } = require('./interactive-network.cjs');

function translations(paper) {
  const pairs = [];
  for (const block of paper.blocks || []) {
    for (const run of block.web_runs || []) {
      if (typeof run.en === 'string' && typeof run.zh === 'string') pairs.push([run.en, run.zh]);
    }
  }
  return pairs.concat(Object.entries(paper.web_visible?.[paper.meta?.target || 'zh'] || {}));
}

function selectionRuns(paper) {
  const result = [];
  for (const b of paper.blocks || []) {
    let en = 0, zh = 0;
    for (const run of b.web_runs || []) {
      if (typeof run.en !== "string") continue;
      result.push([b.id, run.en, en, zh]);
      en += run.en.length; zh += (run.zh ?? run.en).length;
    }
  }
  return result;
}

function fitBounds(bounds, size, zoom) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) return null;
  const y = Math.max(36, Math.min(size.height, Math.round(bounds.y * zoom)));
  const x = Math.max(0, Math.min(size.width, Math.round(bounds.x * zoom)));
  const width = Math.min(size.width - x, Math.round(bounds.width * zoom));
  const height = Math.min(size.height - y, Math.round(bounds.height * zoom));
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function register({ app, ipcMain, WebContentsView, session, trustedWindow, backendJson, getWindow }) {
  const entries = new Map();
  const guestSessions = new Map();
  const toolbar = require("./selection-overlay.cjs")({WebContentsView, ipcMain, getWindow});
  let active, bounds;

  function send(entry) {
    if (entries.get(entry.id) !== entry || entry.window.isDestroyed()) return;
    const contents = entry.window.webContents;
    if (!contents.isDestroyed()) {
      contents.send('easyread:interactive-state', { id: entry.id, ready: entry.ready, error: entry.error,
        count: entry.pairs.length, job: entry.job, message: entry.message, offline: entry.offline,
        missing: entry.missing, hasArchive: entry.hasArchive, archiving: !!entry.saving });
    }
  }

  function show() {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const rect = fitBounds(bounds, { width, height }, window.webContents.getZoomFactor());
    for (const entry of entries.values()) {
      if (!entry.view) continue;
      const visible = Boolean(entry.id === active && rect && entry.ready && !entry.error && window.isVisible() && !window.isMinimized());
      if (visible && (!entry.rect || Object.keys(rect).some(key => rect[key] !== entry.rect[key]))) {
        entry.view.setBounds(rect);
        entry.rect = rect;
      }
      if (visible === entry.visible) continue;
      entry.visible = visible;
      entry.view.setVisible(visible);
      if (!visible && entry.selectionToken) { toolbar.hide(); entry.selectionToken = null; }
      if (entry.ready && !entry.contents.isDestroyed()) entry.contents.send('easyread:interactive-visibility', visible);
    }
  }

  function close(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.selectionToken) toolbar.hide();
    entries.delete(id);
    entry.abort.abort();
    clearInterval(entry.timer);
    clearTimeout(entry.archiveTimer);
    if (entry.offlineSession && !entry.contents?.isDestroyed()) {
      entry.contents?.once('destroyed', () => entry.offlineSession.protocol.unhandle('https'));
    }
    if (entry.view && !entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view);
    if (entry.contents && !entry.contents.isDestroyed()) entry.contents.close();
  }

  function reset() {
    for (const id of entries.keys()) close(id);
    toolbar.destroy();
    active = undefined;
    bounds = undefined;
  }

  const boundWindows = new WeakSet();
  function bind(window) {
    if (boundWindows.has(window)) return;
    boundWindows.add(window);
    for (const event of ['resize', 'show', 'hide', 'minimize', 'restore']) window.on(event, show);
    window.on('closed', reset);
    window.webContents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) reset();
    });
  }

  function apply(entry) {
    if (!entry.ready || !entry.contents || entry.contents.isDestroyed()) return;
    const current = webUrl(entry.contents.getURL());
    if (!current || current.origin !== entry.url.origin || current.pathname !== entry.url.pathname) return;
    entry.contents.send('easyread:interactive-text', entry.pairs, entry.supplemental, entry.runs);
    entry.contents.send('easyread:interactive-language', entry.translated);
  }

  async function refresh(entry) {
    if (entry.refreshing || entries.get(entry.id) !== entry) return;
    entry.refreshing = true;
    try {
      const versions = await backendJson(`${entry.api}/versions`);
      if (versions.paper === entry.paperVersion && versions.job === entry.jobVersion) return;
      if (versions.paper !== entry.paperVersion) {
        const result = await backendJson(`${entry.api}/part/paper`);
        entry.pairs = translations(result.data || {});
        entry.runs = selectionRuns(result.data || {});
        entry.supplemental = Object.keys(result.data?.web_visible?.[result.data?.meta?.target || 'zh'] || {});
        entry.paperVersion = result.version;
        apply(entry);
      }
      if (versions.job !== entry.jobVersion) {
        const result = await backendJson(`${entry.api}/part/job`);
        entry.job = result.data?.state;
        entry.message = result.data?.message;
        entry.jobVersion = result.version;
      }
      send(entry);
    } catch { /* Keep the last saved translation while the backend reconnects. */ }
    finally { entry.refreshing = false; }
  }

  ipcMain.handle('easyread:interactive-open', async (event, id, mode) => {
    trustedWindow(event);
    if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid article ID');
    if (entries.has(id)) return send(entries.get(id));
    const window = getWindow();
    bind(window);
    const entry = { id, window, api: `/api/p/${id}`, pairs: [], ready: false, translated: true, visible: false,
      abort: new AbortController(), urls: new Map(), dir: path.join(app.getPath('userData'), 'OfflineWeb', id) };
    entries.set(id, entry);
    try {
      const { data: paper, version } = await backendJson(`${entry.api}/part/paper`);
      if (entries.get(id) !== entry || window.isDestroyed()) return;
      const url = webUrl(paper?.meta?.live_url || paper?.meta?.interactive_url || paper?.meta?.url);
      if (paper?.meta?.source_type !== 'web' || !url) throw new Error('This article needs a public HTTPS URL');
      const initialUrl = url.href;
      url.hash = ''; // Network manifests use the document URL, without its scroll anchor.
      entry.url = url;
      entry.pairs = translations(paper);
      entry.runs = selectionRuns(paper);
      entry.supplemental = Object.keys(paper.web_visible?.[paper.meta?.target || 'zh'] || {});
      entry.paperVersion = version;
      // Keep the browser cache across restarts, isolated by the site's origin.
      const index = await archive.read(entry.dir, url.href);
      if (entries.get(id) !== entry) return;
      entry.hasArchive = !!index;
      entry.offline = !!index && mode !== 'online';
      let guest = guestSessions.get(url.origin);
      if (entry.offline) {
        guest = session.fromPartition('easyread-local-' + require('node:crypto').randomUUID());
        entry.offlineSession = guest;
        isolateSession(guest, url, index);
        archive.replay(guest, entry.dir, index, () => {
          if (!entry.missing) { entry.missing = true; send(entry); }
        });
      } else if (!guest) {
        const key = createHash('sha256').update(url.origin).digest('hex');
        guest = session.fromPartition(`persist:easyread-interactive-${key}`);
        isolateSession(guest, url);
        function record(details) {
          const owner = [...entries.values()].find(e => e.contents?.id === details.webContentsId);
          if (!owner || owner.urls.size >= archive.maxFiles || details.method !== 'GET' || !webUrl(details.url)) return;
          owner.urls.set(details.url, details.redirectURL || null);
        }
        guest.webRequest.onResponseStarted(record);
        guest.webRequest.onBeforeRedirect(record);
        guestSessions.set(url.origin, guest);
      }
      if (!guest.getPreloadScripts().some(s => s.filePath === path.join(__dirname,'interactive-labels.cjs'))) {
        for (const file of ['interactive-canvas.cjs','interactive-labels.cjs']) guest.registerPreloadScript({type:'frame',filePath:path.join(__dirname,file)});
      }
      const view = new WebContentsView({ webPreferences: { session: guest, contextIsolation: true,
        nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'interactive-page.js') } });
      const contents = view.webContents;
      Object.assign(entry, { view, contents });
      view.setVisible(false);
      window.contentView.addChildView(view);
      const samePage = raw => {
        const next = webUrl(raw);
        return next && next.origin === url.origin && next.pathname === url.pathname;
      };
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', details => { if (!samePage(details.url)) details.preventDefault(); });
      contents.on('will-redirect', details => { if (details.isMainFrame && !samePage(details.url)) details.preventDefault(); });
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.ipc.on('easyread:label-batch',(event,texts) => {
        if (!entry.visible || active!==id || !entry.translated || event.senderFrame!==contents.mainFrame || !samePage(contents.getURL())) return;
        if (!Array.isArray(texts) || texts.length>96 || texts.some(t=>typeof t!=='string'||t.length>1500) || texts.join('').length>12000) return;
        window.webContents.send('easyread:label-batch',{id,texts});
      });
      contents.ipc.on('easyread:guest-selection', (event, selection) => {
        if (!entry.visible || active !== id || event.senderFrame !== contents.mainFrame || !samePage(contents.getURL())) return;
        toolbar.hide();
        entry.selectionToken = selection ? require('node:crypto').randomUUID() : null;
        window.webContents.send('easyread:reader-selection', {id, token:entry.selectionToken, selection,
          scale:contents.getZoomFactor() / window.webContents.getZoomFactor()});
      });
      contents.on('dom-ready', () => {
        if (!samePage(contents.getURL())) return;
        const colors = {yellow:'#f8e6a1',green:'#c8e3b5',blue:'#bedcf2',pink:'#f2c8d9'};
        void contents.insertCSS(Object.entries(colors).map(([c,v]) =>
          '::highlight(er-'+c+'){background-color:'+v+';color:#171717}::highlight(er-'+c+'-u){text-decoration:underline '+v+' 2px}').join('')).catch(() => {});
        entry.ready = true;
        entry.error = undefined;
        show();
        contents.send('easyread:interactive-visibility', entry.visible);
        apply(entry);
        contents.send('easyread:selection-marks', entry.marks || []);
        send(entry);
      });
      const failed = () => {
        entry.ready = false;
        entry.error = true;
        show();
        send(entry);
      };
      contents.on('did-finish-load', () => {
        clearTimeout(entry.archiveTimer);
        if (entry.hasArchive || entry.offline) return;
        entry.archiveTimer = setTimeout(() => {
          if (entry.visible && ![...entries.values()].some(other => other.saving)) {
            void saveArchive(entry).catch(() => {});
          }
        }, 5000);
      });
      contents.on('render-process-gone', failed);
      contents.on('unresponsive', () => {
        failed();
        if (!window.isDestroyed() && entry.view) window.contentView.removeChildView(entry.view);
        entry.view = null;
        entry.abort.abort();
        if (!contents.isDestroyed()) contents.close();
      });
      contents.on('did-fail-load', (_event, code, _message, _url, main) => { if (main && code !== -3) failed(); });
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (entry.visible && active === id && entry.selectionToken && !input.control && !input.meta && !input.alt) {
          const shortcut = input.key === 'Escape' ? 'escape' :
            ({KeyN:'n', KeyQ:'q'}[input.code] || (!input.shift && /^Digit[1-4]$/.test(input.code) && input.code.slice(-1)));
          if (shortcut && (shortcut === 'escape' || entry.selectionKeys)) {
            event.preventDefault();
            if (!input.isAutoRepeat) window.webContents.send('easyread:reader-selection',{id,token:entry.selectionToken,shortcut});
            return;
          }
        }
        if (!(input.control || input.meta) || !['Tab', 'w', 'W'].includes(input.key)) return;
        event.preventDefault();
        window.webContents.send('easyread:interactive-shortcut', { key: input.key, ctrlKey: true, shiftKey: input.shift });
      });
      entry.timer = setInterval(() => { if (entry.visible) void refresh(entry); }, 2300);
      void refresh(entry);
      contents.loadURL(initialUrl).catch(() => { if (!entry.ready) failed(); });
    } catch (error) {
      if (entries.get(id) === entry) close(id);
      throw error;
    }
  });
  ipcMain.handle('easyread:interactive-display', (event, id, rect) => {
    trustedWindow(event);
    active = typeof id === 'string' && /^[a-f0-9]{12}$/.test(id) ? id : undefined;
    bounds = rect;
    show();
    if (entries.has(active)) void refresh(entries.get(active));
  });
  function current(event, id) {
    trustedWindow(event);
    const entry = entries.get(id);
    if (!entry?.ready || !entry.visible || entry.contents.isDestroyed()) throw new Error('Page is not visible');
    return entry;
  }
  ipcMain.handle('easyread:reader-selection', async (event, id, command, data) => {
    trustedWindow(event);
    const entry = entries.get(id);
    if (!entry) return;
    if (command === "marks") {
      entry.marks = data;
      if (entry.ready && !entry.contents.isDestroyed()) entry.contents.send("easyread:selection-marks", data);
      return;
    }
    if (command === "clear") {
      if (entry.selectionToken !== data) return;
      entry.selectionToken = null; toolbar.hide();
      if (entry.ready && !entry.contents.isDestroyed()) entry.contents.send("easyread:selection-clear");
    } else if (command === "toolbar" && entry.visible && active === id && data.token === entry.selectionToken && data.token) {
      const rect = data.rect;
      if (!rect || !Object.values(rect).every(Number.isFinite) || rect.width < 1 || rect.height < 1 || data.html.length > 32000) return;
      entry.selectionKeys = data.shortcuts;
      await toolbar.show(entry.window, {id, ...data});
    } else if (command === "reveal" && entry.ready && entry.visible && active === id && entry.marks?.some(m => m.id === data)) {
      entry.contents.send("easyread:selection-reveal",data);
    } else if (command === "backdrop" && entry.visible && active === id) {
      const shot = await entry.contents.capturePage();
      if (!shot.isEmpty()) return 'data:image/jpeg;base64,' + shot.toJPEG(75).toString('base64');
    }
  });
  ipcMain.handle('easyread:interactive-visible-texts', (event, id) => {
    const entry = current(event, id);
    return entry.contents.executeJavaScriptInIsolatedWorld(999, [{code:'globalThis.easyreadVisibleTexts()'}]);
  });
  function saveArchive(entry) {
    if (!entry.saving) {
      entry.saving = archive.save(entry).then(result => {
        entry.hasArchive = true;
        return result;
      }).finally(() => { entry.saving = null; send(entry); });
      send(entry);
    }
    return entry.saving;
  }
  ipcMain.handle('easyread:interactive-archive', (event, id) => {
    const entry = current(event, id);
    if (entry.offline) throw new Error('Open the online page to save new resources');
    return saveArchive(entry);
  });
  ipcMain.handle('easyread:interactive-close', (event, id) => { trustedWindow(event); close(id); });
  ipcMain.handle('easyread:interactive-language', (event, id, translated) => {
    trustedWindow(event);
    const entry = entries.get(id);
    if (!entry) return;
    entry.translated = ['original-first', 'translation-first'].includes(translated) ? translated : translated === true;
    if (entry.ready && !entry.contents.isDestroyed()) entry.contents.send('easyread:interactive-language', entry.translated);
  });
}

module.exports = { register, translations, fitBounds };
