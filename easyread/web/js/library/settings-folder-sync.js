/* 设置 → 文件夹同步。映射和自动处理选项都在这里管理。 */
(function (PR) {
  "use strict";
  const endpoint = "/api/folder-sync";
  const redraw = (s) => { if (s.tab === "folderSync") PR.settingsRender(); };
  const options = [["enabled", PR.t("自动导入 PDF")], ["translate", PR.t("自动翻译新论文")], ["network_metadata", PR.t("联网补充元数据")]];
  const button = (action, label, disabled, primary = false) => '<button class="btn sm ' + (primary ? "accent" : "line") +
    '" data-sync-action="' + action + '"' + (disabled ? " disabled" : "") + '>' + label + '</button>';

  function checks(values, busy, attr, fields = options) {
    return fields.map(([key, label]) => '<label class="folder-sync-option"><input type="checkbox" ' + attr + '="' + key + '"' +
      ((values[key] ?? (key === "enabled")) ? ' checked' : '') + (busy ? ' disabled' : '') + '> ' + label + '</label>').join('');
  }

  async function load(s) {
    s.folderSyncBusy = true;
    try { s.folderSync = await PR.api(endpoint); s.folderSyncError = s.folderSync.error || ""; }
    catch (err) { s.folderSyncError = err.message; }
    finally { s.folderSyncBusy = false; redraw(s); }
  }

  async function edit(s, body) {
    if (s.folderSyncBusy) return;
    s.folderSyncBusy = true;
    s.folderSyncError = "";
    redraw(s);
    try {
      s.folderSync = await PR.api(endpoint, { method: "POST", body });
      if (body.action === "add" || "new_name" in body) { s.folderSyncDraft = {}; s.folderSyncEditing = null; }
      if (body.action === "set_default") s.folderSyncDefaultDraft = null;
      await PR.lib.load();
    } catch (err) { s.folderSyncError = err.message; }
    finally { s.folderSyncBusy = false; redraw(s); }
  }

  function root(watch, busy) {
    return '<div class="cloud-card" data-sync-root="' + PR.esc(watch.name) + '"><div class="cloud-card-icon">' + PR.icon("folder") +
      '</div><div class="cloud-card-body"><b>' + PR.esc(watch.name) + '</b><div class="cloud-path">' + PR.esc(watch.path) + '</div>' +
      (watch.error ? '<p class="bad" role="status">' + PR.esc(watch.error) + '</p>' : '') + '</div><div class="cloud-card-acts">' +
      button("edit", PR.t("编辑映射"), busy) + button("remove", PR.t("移除"), busy) +
      checks(watch, busy, "data-sync-option") + '</div></div>';
  }

  function defaultFolder(s, busy) {
    const saved = s.folderSync.default;
    const d = s.folderSyncDefaultDraft || saved || { enabled: false };
    return '<section class="folder-sync-default"><h4 class="set-h">' + PR.t("默认文件夹") + '</h4>' +
      '<label class="folder-sync-option"><input type="checkbox" id="syncDefaultEnabled"' + (d.enabled ? ' checked' : '') +
      (busy ? ' disabled' : '') + '> ' + PR.t("启用「全部」文件夹映射") + '</label>' +
      '<p class="hint">' + PR.t("保存后，下载到默认文件夹的 PDF 会自动导入到「全部」。") + '</p>' +
      (saved?.error && d.enabled ? '<p class="bad" role="status">' + PR.esc(saved.error) + '</p>' : '') +
      (d.enabled ? '<label class="field"><span>' + PR.t("默认文件夹路径") + '</span><input class="input" id="syncDefaultPath" required maxlength="4096" value="' +
        PR.esc(d.path || '') + '"></label><div class="sync-draft-options">' + checks(d, busy, "data-sync-default-option", options.slice(1)) + '</div>' :
        saved ? '<div class="cloud-path">' + PR.esc(saved.path) + '</div>' : '') +
      (d.enabled || saved?.enabled ? '<div class="cm-form-acts">' +
        (d.enabled ? button("browse-default", PR.t("选择默认文件夹…"), busy) : '') +
        button("save-default", PR.t("保存默认映射"), busy, true) + '</div>' : '') + '</section>';
  }

  function draft(dlg, s) {
    const enabled = dlg.querySelector("#syncDefaultEnabled");
    if (enabled) {
      const d = s.folderSyncDefaultDraft || s.folderSync.default || {};
      const path = dlg.querySelector("#syncDefaultPath");
      const values = Object.fromEntries(Array.from(dlg.querySelectorAll("[data-sync-default-option]"), (box) => [box.dataset.syncDefaultOption, box.checked]));
      s.folderSyncDefaultDraft = { ...d, ...values, path: path ? path.value : d.path, enabled: enabled.checked };
    }
    const path = dlg.querySelector("#syncFolderPath");
    if (!path) return;
    const selected = Object.fromEntries(Array.from(dlg.querySelectorAll("[data-sync-draft]"), (box) => [box.dataset.syncDraft, box.checked]));
    s.folderSyncDraft = { path: path.value, name: dlg.querySelector("#syncFolderName").value, ...selected };
  }

  PR.settingsTabs.folderSync = {
    render(s) {
      if (!s.folderSync && !s.folderSyncBusy && !s.folderSyncError) load(s);
      const busy = s.folderSyncBusy || !!s.folderSync?.error, d = s.folderSyncDraft || {};
      const editing = s.folderSyncEditing;
      return '<div class="cloud-settings folder-sync-settings"><p class="set-lead">' + PR.t("映射的文件夹及其子文件夹会显示在文献库目录中。") + '</p>' +
        '<p class="hint">' + PR.t("开启自动导入后，已有 PDF 只入库。自动翻译只处理随后新增的论文，一次发现超过 {n} 个文件时先只入库。", { n: 5 }) + '</p>' +
        '<p class="hint">' + PR.t("开启联网补充元数据后，会用新导入论文的 DOI 或 arXiv 编号查询书目信息。") + '</p>' +
        (s.folderSyncError ? '<p class="bad" role="alert">' + PR.esc(s.folderSyncError) + '</p>' : '') +
        (s.folderSync ? '<div class="cloud-cards">' + s.folderSync.roots.map((w) => root(w, busy)).join("") + '</div>' :
          busy ? '<p class="hint" role="status">' + PR.t("正在加载…") + '</p>' : button("reload", PR.t("重试"), false)) +
        (s.folderSync ? defaultFolder(s, busy) : '') +
        '<h4 class="set-h">' + (editing ? PR.t("编辑映射") : PR.t("添加文件夹映射")) + '</h4><label class="field"><span>' + PR.t("本地文件夹路径") +
        '</span><input class="input" id="syncFolderPath" maxlength="4096" value="' + PR.esc(d.path || "") + '"></label>' +
        '<label class="field"><span>' + PR.t("显示名称（可选）") + '</span><input class="input" id="syncFolderName" maxlength="80" value="' + PR.esc(d.name || "") + '"></label>' +
        '<div class="sync-draft-options">' + checks(d, busy, "data-sync-draft") + '</div>' +
        '<div class="cm-form-acts">' + (editing ? button("cancel-edit", PR.t("取消"), busy) : '') + button("browse", PR.t("选择文件夹…"), busy) +
        button("save-mapping", editing ? PR.t("保存映射") : PR.t("添加映射"), busy, true) + '</div></div>';
    },
    sync(s, dlg) { draft(dlg, s); },
    async click(e, s, dlg) {
      const b = e.target.closest("[data-sync-action]");
      if (!b || s.folderSyncBusy) return false;
      draft(dlg, s);
      const action = b.dataset.syncAction;
      if (action === "reload") { await load(s); return false; }
      if (action === "browse" || action === "browse-default") {
        const path = await PR.pickFolder({ title: PR.t("选择要映射的文件夹") });
        const target = action === "browse-default" ? s.folderSyncDefaultDraft : s.folderSyncDraft;
        if (path && target) { target.path = path; redraw(s); }
        return false;
      }
      if (action === "save-default") {
        const { enabled, path, translate, network_metadata } = s.folderSyncDefaultDraft;
        if (enabled && !dlg.querySelector("#syncDefaultPath").reportValidity()) return false;
        await edit(s, enabled ? { action: "set_default", enabled, path, translate, network_metadata } : { action: "set_default", enabled });
        return false;
      }
      if (action === "cancel-edit") { s.folderSyncEditing = null; s.folderSyncDraft = {}; return true; }
      if (action === "save-mapping") {
        const { name, ...fields } = s.folderSyncDraft;
        const body = s.folderSyncEditing ? { action: "update", name: s.folderSyncEditing, new_name: name, ...fields } : { action: "add", name, ...fields };
        await edit(s, body);
        return false;
      }
      const name = b.closest("[data-sync-root]").dataset.syncRoot;
      const watch = s.folderSync.roots.find((w) => w.name === name);
      if (action === "edit") {
        s.folderSyncEditing = name;
        s.folderSyncDraft = { ...watch };
        redraw(s);
        PR.$("#syncFolderPath").focus();
        return false;
      }
      if (action === "remove") {
        if (await PR.confirm({ title: PR.t("移除文件夹映射？"), body: PR.t("磁盘文件、已导入的论文和笔记都会保留。"), ok: PR.t("移除") })) {
          if (s.folderSyncEditing === name) { s.folderSyncEditing = null; s.folderSyncDraft = {}; }
          await edit(s, { action, name });
        }
      }
      return false;
    },
    change(e, s, dlg) {
      if (e.target.id === "syncDefaultEnabled") { draft(dlg, s); return true; }
      const option = e.target.dataset.syncOption;
      if (option) {
        draft(dlg, s);
        const name = e.target.closest("[data-sync-root]").dataset.syncRoot;
        if (s.folderSyncEditing === name) s.folderSyncDraft[option] = e.target.checked;
        edit(s, { action: "update", name, [option]: e.target.checked });
      }
      return false;
    },
  };
})(window.PR);
