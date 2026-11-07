const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

async function desktop(platform = "darwin", lock = true, ready = true, argv = [], appDataBroken = false) {
  const app = new EventEmitter();
  Object.assign(app, {
    setPath(name, value) { this.paths = { ...this.paths, [name]: value }; },
    getPath(name) { if (appDataBroken && name === "appData") throw new Error("Failed to get 'appData' path"); return "/tmp"; }, getLocale: () => "zh-CN", isPackaged: true,
    requestSingleInstanceLock: () => lock, whenReady: () => Promise.resolve(), isReady: () => true,
    setAsDefaultProtocolClient(scheme) { this.protocol = scheme; },
    quit() { this.quitCalled = true; this.emit("before-quit", { preventDefault() {} }); },
    relaunch() { this.relaunched = true; }, exit() { this.exited = true; },
  });
  const windows = [], launches = [], menus = [], stages = [], requests = [], scripts = [], handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  class Window extends EventEmitter {
    constructor() {
      super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.mainFrame = { url: "http://127.0.0.1:9876/" }; this.webContents.isDestroyed = () => false;
      // 页面收到消息就写完回一声（见 preload.cjs）
      this.webContents.send = channel => { requests.push("asked:" + channel); queueMicrotask(() => ipcMain.emit("easyread:page-saved", { sender: this.webContents, senderFrame: this.webContents.mainFrame })); };
      this.webContents.executeJavaScript = async source => { scripts.push(source); return true; };
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(w => !w.closed); }
    async loadURL(url) { this.url = url; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    isMinimized() { return false; }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) { this.closed = true; this.emit("closed"); }
    }
  }
  const Menu = {
    buildFromTemplate(items) { return { items, popup() { menus.push(items); } }; },
    setApplicationMenu(menu) { app.menu = menu; },
  };
  const childProcess = {
    execFileSync: () => "__PATH__/usr/bin:/bin__PATH__",
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit("exit", 0, "SIGTERM"); };
      launches.push({ command, args, options, child });
      if (ready) queueMicrotask(() => child.stdout.emit("data", "EasyRead 已启动：http://127.0.0.1:9876\n"));
      return child;
    },
  };
  const proc = new EventEmitter();
  Object.assign(proc, { platform, env: {}, resourcesPath: "/tmp/Resources", argv: ["EasyRead.exe", ...argv] });
  const fakeRequire = name => name === "electron" ? { app, BrowserWindow: Window, Menu, ipcMain, crashReporter: { start() {} }, dialog: { showErrorBox() {}, showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/chosen"] }) }, shell: {} }
    : name === "child_process" ? childProcess : name === "fs" ? { existsSync: () => true }
    : name === "http" ? { request(url, options, callback) {
      requests.push(url.pathname);
      const req = new EventEmitter(); req.setTimeout = () => {}; req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {}; callback(res);
        res.emit("data", JSON.stringify(url.pathname === "/api/library" ? { token: "test-token" } : { ok: true }));
        res.emit("end");
        if (url.pathname === "/api/shutdown") launches[launches.length - 1].child.kill();
      }); return req;
    } }
    : name === "./startup-feedback.cjs" ? { ...require("../../electron/startup-feedback.cjs"), mark(_app, stage) { stages.push(stage); }, loginShellPath: async () => "/usr/bin:/bin" }
    : name === "./desktop-updates.cjs" ? { registerUpdates() {} }
    : name === "./desktop-exports.cjs" ? require("../../electron/desktop-exports.cjs")
    : name === "./desktop-tabs.cjs" ? require("../../electron/desktop-tabs.cjs")
    : name === "./deep-link.cjs" ? require("../../electron/deep-link.cjs")
    : name === "./data-dir.cjs" ? { prepare: async () => null }
    : name === "electron-updater" ? { autoUpdater: {} }
    : name === "./window-state.cjs" ? { options: () => ({ opts: { width: 1440, height: 960 }, maximized: false }), track() {} }
    : require(name);
  const source = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  vm.runInNewContext(source, { require: fakeRequire, process: proc, __dirname: "/tmp/electron", setTimeout, clearTimeout, console });
  const settled = () => new Promise(resolve => setImmediate(resolve));
  await settled();
  return { app, windows, launches, menus, handlers, stages, requests, scripts, ipcMain, settled };
}

test("startup survives a missing appData path instead of crashing the main process", async () => {
  const d = await desktop("win32", true, true, [], true);
  assert.ok(d.app.paths.userData.endsWith("EasyRead"));
  assert.equal(d.windows.length, 1);
  d.app.quit();
});

test("a renderer crash restores the tab shell and a repeated crash can reopen the library", async () => {
  const d = await desktop("win32");
  const win = d.windows[0], wc = win.webContents, library = win.url;
  const reading = library + "#paper=paper1&paper=paper2&active=paper2";
  wc.emit("did-navigate-in-page", {}, reading, true);
  wc.emit("did-navigate-in-page", {}, "http://127.0.0.1:9876/read/paper2#b-p2", false);
  const crash = { reason: "crashed", exitCode: -2147483645 };
  wc.emit("render-process-gone", {}, crash);
  assert.equal(win.url, reading);
  wc.emit("render-process-gone", {}, crash);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.url, library);
  d.app.quit();
});

test("macOS keeps native editing roles and offers input context actions", async () => {
  const d = await desktop();
  assert.deepEqual(Array.from(d.app.menu.items, x => x.role), ["appMenu", "editMenu", "windowMenu"]);
  d.windows[0].webContents.emit("context-menu", {}, { isEditable: true, selectionText: "", editFlags: { canPaste: true } });
  assert.ok(d.menus[0].some(x => x.role === "paste" && x.enabled));
  d.app.quit();
});

test("reopening a macOS window reuses one backend, even during repeated activation", async () => {
  const d = await desktop();
  d.windows[0].close();
  await d.settled();
  d.app.emit("activate"); d.app.emit("activate");
  await d.settled();
  assert.equal(d.launches.length, 1);
  assert.equal(d.windows.length, 2);
  d.app.emit("second-instance");
  assert.equal(d.windows[1].focused, true);
  d.app.quit();
  await d.settled();
  assert.equal(d.launches[0].child.killed, true);
});

test("a second app instance exits before starting a backend", async () => {
  const d = await desktop("darwin", false);
  assert.equal(d.app.quitCalled, true);
  assert.equal(d.launches.length, 0);
});

test("Windows retains its existing menu behavior", async () => {
  const d = await desktop("win32");
  assert.equal(d.app.menu, null);
  d.app.quit();
});

test("quitting asks the page to save before stopping the backend", async () => {
  const d = await desktop("win32");
  d.app.quit();
  await new Promise(resolve => setTimeout(resolve, 200));
  const order = d.requests.filter(x => x.startsWith("asked:") || x === "/api/shutdown");
  assert.deepEqual(Array.from(order), ["asked:easyread:before-quit", "/api/shutdown"]);
});

test("Windows close button saves before the renderer is destroyed", async () => {
  const d = await desktop("win32");
  d.windows[0].close();
  assert.notEqual(d.windows[0].closed, true);
  await d.settled();
  const order = d.requests.filter(x => x.startsWith("asked:") || x === "/api/shutdown");
  assert.deepEqual(Array.from(order), ["asked:easyread:before-quit", "/api/shutdown"]);
});

test("quitting goes ahead when the page never answers", async () => {
  const d = await desktop("win32");
  d.windows[0].webContents.send = () => {};  // 页面卡住，一声不吭
  d.app.quit();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(d.requests.includes("/api/shutdown"), "不该卡在退出上");
  assert.equal(d.launches[0].child.killed, true);
});

test("the startup window is visible while the backend is still starting", async () => {
  const d = await desktop("darwin", true, false);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].shown, true);
  assert.match(d.windows[0].url, /^data:text\/html/);
  assert.ok(d.stages.indexOf("startup-window-visible") < d.stages.indexOf("backend-spawn"));
  d.launches[0].child.stdout.emit("data", "EasyRead 已启动：http://127.0.0.1:9876\n");
  await d.settled();
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876/web/tabs.html");
  assert.ok(d.stages.includes("library-loaded"));
  d.app.quit(); await d.settled();
});

test("login shell discovery yields without blocking and tolerates shell errors", async () => {
  const { loginShellPath } = require("../../electron/startup-feedback.cjs");
  let callback;
  const pending = loginShellPath("darwin", "/bin/zsh", (_shell, _args, options, done) => {
    assert.equal(options.timeout, 5000); callback = done;
  });
  assert.ok(pending instanceof Promise);
  callback(null, "noise\n__PATH__/usr/local/bin:/usr/bin__PATH__\n");
  assert.equal(await pending, "/usr/local/bin:/usr/bin");
  assert.equal(await loginShellPath("darwin", "/bin/zsh", (_s, _a, _o, done) => done(new Error("timeout"))), "");
  assert.equal(await loginShellPath("win32", "", () => { throw new Error("unexpected shell"); }), "");
});


test("cloud library IPC restricts folder picking and relaunch to the local main frame", async () => {
  const d = await desktop();
  const sender = d.windows[0].webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  assert.equal(await d.handlers.get("easyread:pick-folder")(event), "/tmp/chosen");
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender: {}, senderFrame: sender.mainFrame }), /Untrusted/);
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender, senderFrame: { url: "https://example.com" } }), /Untrusted/);
  await d.handlers.get("easyread:relaunch")(event);
  assert.equal(d.launches[0].child.killed, true);
  assert.equal(d.app.relaunched, true);
  assert.equal(d.app.exited, true);
});

const SHA = "a".repeat(64);

test("easyread:// links open the paper once the backend is ready", async () => {
  const d = await desktop("win32", true, true, [`easyread://open?sha256=${SHA}&block=p3-2`]);
  await d.settled();
  assert.equal(d.app.protocol, "easyread");
  const url = new URL(d.windows[0].url);
  assert.equal(url.pathname, '/web/tabs.html');
  assert.equal(url.searchParams.get('open'), `/open?sha256=${SHA}&block=p3-2`);
  d.app.quit();
});

test("a link from a second instance reuses the open window", async () => {
  const d = await desktop("win32");
  await d.settled();
  d.app.emit("second-instance", {}, ["EasyRead.exe", "easyread://open?id=abc123def456"]);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876/web/tabs.html");
  assert.ok(d.scripts.some(source => source.includes('/open?id=abc123def456')));
  assert.equal(d.windows[0].focused, true);
  d.app.quit();
});

test("macOS open-url links are handled and unknown links ignored", async () => {
  const d = await desktop();
  await d.settled();
  d.app.emit("open-url", { preventDefault() {} }, "easyread://other?id=abc123def456");
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876/web/tabs.html");
  d.app.emit("open-url", { preventDefault() {} }, `easyread://open?sha256=${SHA}&block=<x>`);
  assert.ok(d.scripts.some(source => source.includes(`/open?sha256=${SHA}`)));
  d.app.quit();
});

test("a failed tab save keeps the backend and window alive", async () => {
  const d = await desktop("win32");
  const wc = d.windows[0].webContents;
  wc.send = () => queueMicrotask(() => d.ipcMain.emit('easyread:page-saved',
    { sender: wc, senderFrame: wc.mainFrame }, { ok: false, error: 'save failed' }));
  d.windows[0].close();
  await d.settled();
  assert.equal(d.requests.includes('/api/shutdown'), false);
  assert.notEqual(d.windows[0].closed, true);
  wc.send = () => queueMicrotask(() => d.ipcMain.emit('easyread:page-saved',
    { sender: wc, senderFrame: wc.mainFrame }, { ok: true }));
  d.app.quit();
  await d.settled();
  assert.ok(d.requests.includes('/api/shutdown'));
});
