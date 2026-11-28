const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Only the trusted desktop tab shell uses this bridge. The guest has a different preload.
contextBridge.exposeInMainWorld("easyreadInteractive", {
  open: (id, mode) => ipcRenderer.invoke("easyread:interactive-open", id, mode),
  archive: id => ipcRenderer.invoke("easyread:interactive-archive", id),
  visibleTexts: id => ipcRenderer.invoke("easyread:interactive-visible-texts", id),
  display: (id, rect) => ipcRenderer.invoke("easyread:interactive-display", id, rect),
  close: id => ipcRenderer.invoke("easyread:interactive-close", id),
  language: (id, translated) => ipcRenderer.invoke("easyread:interactive-language", id, translated),
  selection: (id, command, data) => ipcRenderer.invoke("easyread:reader-selection", id, command, data),
  onSelection: callback => subscribe("easyread:reader-selection", callback),
  onState: callback => subscribe("easyread:interactive-state", callback),
  onLabels: callback => subscribe("easyread:label-batch", callback),
  onShortcut: callback => subscribe("easyread:interactive-shortcut", callback),
});

contextBridge.exposeInMainWorld("easyreadDesktop", {
  isElectron: true,
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke("easyread:pick-folder"),
  saveExport: (payload) => ipcRenderer.invoke("easyread:save-export", payload),
  exportDirectory: () => ipcRenderer.invoke("easyread:export-directory"),
  relaunch: () => ipcRenderer.invoke("easyread:relaunch"),
  updateState: () => ipcRenderer.invoke("easyread:update-state"),
  downloadUpdate: () => ipcRenderer.invoke("easyread:update-download"),
  installUpdate: () => ipcRenderer.invoke("easyread:update-install"),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("easyread:update-state", listener);
    return () => ipcRenderer.removeListener("easyread:update-state", listener);
  },
  /* 退出软件前来一下：页面写完回一声，主进程才停后端（见 main.cjs） */
  onBeforeQuit: (callback) => {
    const listener = async () => {
      try {
        const result = await callback();
        const ok = result !== false && !(Array.isArray(result) && result.some(value => value === false));
        ipcRenderer.send("easyread:page-saved", { ok });
      } catch (error) {
        ipcRenderer.send("easyread:page-saved", { ok: false, error: error.message });
      }
    };
    ipcRenderer.on("easyread:before-quit", listener);
    return () => ipcRenderer.removeListener("easyread:before-quit", listener);
  },
});
