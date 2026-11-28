/* A trusted, transient child view puts the reader's toolbar above the site. */
const path = require("node:path");

module.exports = function selectionOverlay({WebContentsView, ipcMain, getWindow}) {
  let view, ready, model, release;
  function destroy() {
    clearTimeout(release);
    if (view) {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    view = ready = model = null;
  }
  function hide() {
    model = null;
    view?.setVisible(false);
    clearTimeout(release);
    if (view) release = setTimeout(destroy, 12000);
  }
  async function show(win, next) {
    clearTimeout(release);
    model = next;
    if (!view) {
      view = new WebContentsView({webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false,
        preload:path.join(__dirname, "selection-toolbar-preload.cjs")}});
      view.setBackgroundColor("#00000000");
      view.setVisible(false);
      win.contentView.addChildView(view);
      const wc = view.webContents;
      wc.setWindowOpenHandler(() => ({action:"deny"}));
      wc.on("will-navigate", event => event.preventDefault());
      ready = wc.loadURL(new URL("/web/selection-toolbar.html",win.webContents.getURL()).href);
    }
    try { await ready; } catch { if (model === next) destroy(); return; }
    if (model !== next || !view || win.isDestroyed()) return;
    const zoom = win.webContents.getZoomFactor();
    view.webContents.setZoomFactor(zoom);
    view.setBounds(Object.fromEntries(Object.entries(next.rect).map(([key,value]) => [key,Math.round(value*zoom)])));
    view.webContents.send("easyread:toolbar-paint", {html:next.html, theme:next.theme, token:next.token});
    view.setVisible(true);
  }
  ipcMain.on("easyread:toolbar-pick", (event, token, index) => {
    if (!model || event.sender !== view?.webContents || event.senderFrame !== event.sender.mainFrame ||
        token !== model.token || !Number.isInteger(index) || index < 0 || index >= 24) return;
    const {id} = model, win = getWindow();
    hide();
    if (!win || win.isDestroyed()) return;
    win.webContents.focus();
    win.webContents.send("easyread:reader-selection", {id, token, index});
  });
  return {show, hide, destroy};
};
