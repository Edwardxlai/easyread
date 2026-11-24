/* 标签列表、标签选择和规则编辑、单篇 AI 操作。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const pending = new Map();
  const expandedKey = "easyread-labels-expanded";
  let labelsExpanded = PR.ls.get(expandedKey, true) !== false;
  const assigned = (item) => item.labels || [];
  const normalize = (text) => text.trim().replace(/\s+/g, " ").normalize("NFC");
  const key = (text) => normalize(text).toLowerCase();
  const write = (path, body) => PR.api(path, { method: "POST", body });
  const pathFor = (id) => "/api/p/" + encodeURIComponent(id) + "/labels";
  const enabledTools = () => PR.PAPER_LABEL_TOOLS.filter((tool) => L.labelFeatures[tool.id] === true);

  const sourceHref = (item, source) => source.anchor ?
    "/read/" + encodeURIComponent(item.id) + "#b-" + encodeURIComponent(source.anchor) :
    "/p/" + encodeURIComponent(item.id) + (item.source_type === "web" ? "/source.html" : "/source.pdf#page=" + (source.page || 1));

  L.labelChips = (item, withEvidence = false) => assigned(item).map((label) => {
    const body = PR.icon("tag", "sm") + '<span>' + PR.esc(label) + '</span>';
    if (withEvidence && item.evidence_labels?.includes(label)) {
      const title = PR.esc(PR.t("查看「{name}」的原文依据", { name: label }));
      return '<button type="button" class="chip paper-label" data-label-proof="' + PR.esc(label) +
        '" title="' + title + '" aria-label="' + title + '">' + body + '</button>';
    }
    return '<span class="chip paper-label" title="' + PR.esc(label) + '">' + body + '</span>';
  }).join("");

  L.labelSidebar = function () {
    const counts = new Map();
    for (const paper of L.items) {
      for (const label of assigned(paper)) counts.set(label, (counts.get(label) || 0) + 1);
    }
    const heading = PR.t("新建标签");
    const rows = L.labels.map((label) => {
      const active = L.view === "label" && L.tag === label;
      return '<button type="button" draggable="true" class="srow' + (active ? ' on' : '') + '" data-paper-label="' + PR.esc(label) +
        '" title="' + PR.esc(label) + '" aria-pressed="' + active + '">' + PR.icon("tag", "sm") +
        '<span class="t">' + PR.esc(label) + '</span><span class="n">' + (counts.get(label) || 0) + '</span></button>';
    });
    return '<h3><button type="button" data-label-toggle aria-controls="paperLabelList" aria-expanded="' + labelsExpanded + '">' +
      PR.t("标签") + PR.icon("chevron", "sm") + '</button><button type="button" class="h-add" data-label-create title="' + PR.esc(heading) +
      '" aria-label="' + PR.esc(heading) + '"' + (L.loadStatus === "ready" ? '' : ' disabled') + '>' +
      PR.icon("plus", "sm") + '</button></h3><div class="sgroup" id="paperLabelList"' + (labelsExpanded ? '' : ' hidden') + '>' + rows.join("") + '</div>';
  };

  L.labelDetail = function (item) {
    const busy = pending.get(item.id);
    const disabled = L.loadStatus === "ready" ? "" : " disabled";
    const chips = L.labelChips(item, true);
    const aiButton = ({ action, name, progress, description }) => '<button type="button" class="btn sm line" data-label-' + action +
      ' title="' + PR.esc(description) + '"' + (busy ? ' disabled' : disabled) + '>' +
      (busy === action ? '<span class="spin" aria-hidden="true"></span>' + progress : PR.icon("sparkle", "sm") + name) + '</button>';
    return '<section class="paper-labels"><h4>' + PR.t("标签") + '</h4>' +
      (chips ? '<div class="tags">' + chips + '</div>' : '') +
      '<div class="label-actions"><button type="button" class="btn sm line" data-label-edit' + disabled + '>' +
      PR.icon("tag", "sm") + PR.t("编辑标签…") + '</button>' +
      enabledTools().map(aiButton).join("") +
      '</div></section>';
  };

  async function createLabel() {
    const name = await PR.promptText({ title: PR.t("新建标签"), placeholder: PR.t("标签名称"), max: 60 });
    if (!name) return;
    try {
      await write("/api/library/labels", { name });
      await L.load();
    } catch (error) {
      PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(error.message) }));
    }
  }

  async function openRuleEditor(name, drafts, onSuggestionEdit, evidenceItem) {
    const isDraft = !!drafts?.has(name);
    const title = PR.t("「{name}」的规则", { name });
    const dialog = PR.el("dialog", { class: "confirm label-rule-editor", "aria-labelledby": "labelRuleTitle" },
      '<div class="cf-title" id="labelRuleTitle">' + PR.esc(title) + '</div>' +
      '<form><p class="hint" id="labelRuleHelp">' + (onSuggestionEdit ? PR.t("请为 AI 建议的标签写明匹配条件。") :
        PR.t("写下 AI 应匹配的条件和例外。留空时按标签名称判断。")) + '</p>' +
      '<textarea class="input" rows="5" maxlength="1000" aria-label="' + PR.esc(PR.t("标签规则")) +
      '" aria-describedby="labelRuleHelp"></textarea>' +
      (isDraft ? '<p class="hint">' + PR.t("这条规则会随新标签一起保存。") + '</p>' : '') +
      '<p class="err" role="alert" hidden></p><div class="cf-acts"><button type="button" class="btn sm" data-cancel-rule>' +
      PR.t("取消") + '</button><button type="submit" class="btn sm accent">' + PR.t("保存规则") + '</button></div></form>');
    const form = PR.$("form", dialog);
    const field = PR.$("textarea", form);
    const save = PR.$('[type="submit"]', form);
    const cancel = PR.$("[data-cancel-rule]", form);
    const error = PR.$('[role="alert"]', form);
    const showError = (message) => { error.textContent = message; error.hidden = false; };
    let saving = false, previousRule = "";
    cancel.onclick = () => dialog.close();
    dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const rule = field.value.trim();
      if (isDraft) {
        if (onSuggestionEdit && !rule) {
          showError(PR.t("请为 AI 建议的标签写明匹配条件。"));
          field.focus();
          return;
        }
        drafts.set(name, rule);
        if (onSuggestionEdit) onSuggestionEdit(rule);
        dialog.close();
        return;
      }
      saving = field.disabled = save.disabled = cancel.disabled = true;
      error.hidden = true;
      try {
        await write("/api/library/labels/rule", { name, rule, previous_rule: previousRule });
        dialog.close();
      } catch (failure) {
        showError(failure.message);
      } finally {
        saving = field.disabled = save.disabled = cancel.disabled = false;
      }
    });

    field.disabled = save.disabled = !isDraft;
    document.body.appendChild(dialog);
    dialog.showModal();
    if (isDraft) {
      field.value = drafts.get(name);
    } else {
      field.placeholder = PR.t("加载中…");
      try {
        let entry;
        if (evidenceItem) {
          entry = await PR.api(pathFor(evidenceItem.id) + "/evidence?name=" + encodeURIComponent(name));
        } else {
          const { labels } = await PR.api("/api/library/labels?name=" + encodeURIComponent(name));
          entry = labels.find((label) => key(label.name) === key(name));
        }
        if (!dialog.open) return;
        if (!entry) throw new Error(PR.t("找不到这个论文标签"));
        if (evidenceItem) {
          const citation = PR.el("blockquote", { class: "label-proof" }, PR.esc(entry.quote) +
            ' <a target="_blank" rel="noopener" href="' + PR.esc(sourceHref(evidenceItem, entry)) + '">' + PR.t("查看原文") + '</a>');
          form.before(citation);
        }
        previousRule = field.value = entry.rule;
        field.disabled = save.disabled = false;
      } catch (failure) {
        showError(failure.message);
      } finally {
        field.placeholder = "";
      }
    }
    if (dialog.open && !field.disabled) field.focus();
  }

  function openPicker(item, preview) {
    const matches = preview?.matches || [], suggestions = preview?.suggestions || [];
    const candidates = new Map([...matches, ...suggestions].map((row) => [row.name, row]));
    const initial = new Set(preview ? [] : assigned(item));
    const selected = new Set(preview ? matches.map((row) => row.name) : initial);
    const draftRules = new Map(suggestions.map(({ name, rule }) => [name, rule]));
    const available = new Set(preview ? candidates.keys() : [...L.labels, ...initial]);
    const dialog = PR.el("dialog", { class: "confirm label-picker", "aria-labelledby": "labelPickerTitle" },
      '<div id="labelPickerTitle" class="cf-title">' + (preview ? (matches.length ? PR.t("匹配的已有标签") : PR.t("选择要新建的标签")) : PR.t("编辑标签…")) + '</div>' +
      '<div class="cf-body label-paper-title">' + PR.esc(PR.titles(item).main) + '</div>' +
      '<form><fieldset>' + (preview ? '' : '<div class="label-input-row"><input class="input" maxlength="60" autocomplete="off" placeholder="' +
      PR.esc(PR.t("搜索或输入标签名")) + '" aria-label="' + PR.esc(PR.t("搜索或输入标签名")) + '">' +
      '<button type="button" class="btn sm line" data-new-label>' + PR.t("新建并添加") + '</button></div>') +
      '<div class="label-options"></div><p class="err" role="alert" hidden></p>' +
      '<div class="cf-acts"><button type="button" class="btn sm" data-cancel>' + PR.t("取消") + '</button>' +
      '<button type="submit" class="btn sm accent">' + (preview ? PR.t("保存所选标签") : PR.t("保存标签")) + '</button></div></fieldset></form>');
    const form = PR.$("form", dialog);
    const fields = PR.$("fieldset", form);
    const input = PR.$("input", form);
    const options = PR.$(".label-options", form);
    const create = PR.$("[data-new-label]", form);
    const save = PR.$('[type="submit"]', form);
    const error = PR.$("[role=alert]", form);
    const matchingName = () => [...available].find((label) => key(label) === key(input.value));

    function draw() {
      const query = input ? key(input.value) : "";
      if (create) create.disabled = !query || !!matchingName();
      save.disabled = preview && !selected.size;
      const shown = [...available].filter((label) => key(label).includes(query)).sort((a, b) => a.localeCompare(b, PR.lang));
      options.innerHTML = shown.map((label) => {
        const name = PR.esc(label);
        const ruleTitle = PR.esc(PR.t("编辑「{name}」的规则", { name: label }));
        const candidate = candidates.get(label);
        const proof = candidate ? '<small class="label-proof">“' + PR.esc(candidate.quote) + '”</small>' : "";
        return '<div class="label-choice" data-label-choice="' + name + '"><label><input type="checkbox" value="' + name + '"' +
          (selected.has(label) ? ' checked' : '') + '><span>' + name + (preview ?
            '<small class="label-rule-summary">' + PR.esc(draftRules.get(label) ?? candidate.rule) + '</small>' + proof : '') + '</span></label>' +
          (candidate ? '<a class="btn sm" target="_blank" rel="noopener" href="' + PR.esc(sourceHref(item, candidate)) + '">' + PR.t("查看原文") + '</a>' : "") +
          '<button type="button" class="btn sm" data-edit-rule title="' + ruleTitle + '" aria-label="' + ruleTitle + '">' +
          PR.t("规则") + '</button></div>';
      }).join("") ||
        '<p class="hint">' + (query ? PR.t("没有匹配的标签") : PR.t("还没有标签")) + '</p>';
    }

    function stageName() {
      const name = matchingName() || normalize(input.value);
      if (!name) return;
      if (!available.has(name)) {
        available.add(name);
        draftRules.set(name, "");
      }
      selected.add(name);
      input.value = "";
      draw();
      input.focus();
    }

    input?.addEventListener("input", draw);
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      stageName();
    });
    if (create) create.onclick = stageName;
    options.addEventListener("change", (event) => {
      const choice = event.target;
      if (choice.checked) selected.add(choice.value);
      else selected.delete(choice.value);
      save.disabled = preview && !selected.size;
    });
    function editChoice(row) {
      const summary = PR.$(".label-rule-summary", row);
      openRuleEditor(row.dataset.labelChoice, draftRules, summary && draftRules.has(row.dataset.labelChoice) ? (rule) => { summary.textContent = rule; } : null);
    }
    options.addEventListener("click", (event) => {
      const button = event.target.closest("[data-edit-rule]");
      if (button) editChoice(button.closest("[data-label-choice]"));
    });
    options.addEventListener("contextmenu", (event) => {
      const row = event.target.closest("[data-label-choice]");
      if (!row || fields.disabled) return;
      event.preventDefault();
      editChoice(row);
    });
    PR.$("[data-cancel]", form).onclick = () => dialog.close();
    dialog.addEventListener("cancel", (event) => { if (fields.disabled) event.preventDefault(); });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (fields.disabled || save.disabled) return;
      const add = [...selected].filter((label) => !initial.has(label));
      const remove = [...initial].filter((label) => !selected.has(label));
      if (!add.length && !remove.length) return dialog.close();
      const newRules = Object.fromEntries(add.filter((name) => draftRules.get(name)).map((name) => [name, draftRules.get(name)]));
      fields.disabled = true;
      error.hidden = true;
      try {
        const result = preview ? await write(pathFor(item.id) + "/confirm", { preview: preview.preview, selected: add, rules: newRules }) :
          await write(pathFor(item.id), { add, remove, new_rules: newRules });
        dialog.close();
        await L.load();
        if (preview && result.added.length) PR.toast(PR.t("已添加 {n} 个标签", { n: result.added.length }));
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        fields.disabled = false;
      }
    });

    draw();
    document.body.appendChild(dialog);
    dialog.showModal();
    (input || PR.$('input[type="checkbox"]', options))?.focus();
  }

  async function runAI(item, mode) {
    if (pending.has(item.id) || !enabledTools().some((tool) => tool.action === mode)) return;
    pending.set(item.id, mode);
    PR.renderDetail();
    try {
      const result = await write(pathFor(item.id) + "/preview", {});
      if (L.selected !== item.id) return;
      if (result.matches.length || result.suggestions.length) openPicker(L.byId(item.id) || item, result);
      else PR.toast(PR.t("AI 没有找到可新增的标签"));
    } catch (error) {
      const detail = { msg: PR.esc(error.message) };
      PR.toast(PR.t("AI 打标签失败：{msg}", detail));
    } finally {
      pending.delete(item.id);
      if (L.selected === item.id) PR.renderDetail();
    }
  }

  L.labelMenuItems = (item) => {
    if (item.load_error) return [];
    const inactive = L.loadStatus !== "ready";
    const aiDisabled = inactive || pending.has(item.id);
    return [
      { label: PR.t("编辑标签…"), icon: "tag", disabled: inactive, fn: () => openPicker(item) },
      ...enabledTools().map((tool) => ({ label: tool.name, icon: "sparkle", disabled: aiDisabled, fn: () => runAI(item, tool.action) })),
    ];
  };

  const side = PR.$("#side");
  side.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-label-toggle]");
    if (toggle) {
      event.stopPropagation(); // Folding the list keeps the selected paper and its details open.
      labelsExpanded = !labelsExpanded;
      PR.ls.set(expandedKey, labelsExpanded);
      toggle.setAttribute("aria-expanded", String(labelsExpanded));
      PR.$("#paperLabelList", side).hidden = !labelsExpanded;
      return;
    }
    if (event.target.closest("[data-label-create]")) return createLabel();
    const row = event.target.closest("[data-paper-label]");
    if (!row) return;
    const label = row.dataset.paperLabel;
    const active = L.view === "label" && L.tag === label;
    L.view = active ? "all" : "label";
    L.tag = active ? null : label;
    L.select(null);
    L.render();
    const nav = PR.$('#libraryNavBtn[aria-expanded="true"]');
    if (nav) { nav.click(); nav.focus(); }
    else PR.$$('[data-paper-label]', side).find((button) => button.dataset.paperLabel === label)?.focus({ preventScroll: true });
  });
  side.addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-paper-label]");
    if (!row || L.loadStatus !== "ready") return;
    event.preventDefault();
    openRuleEditor(row.dataset.paperLabel);
  });

  PR.$("#detail").addEventListener("click", (event) => {
    const item = L.byId(L.selected);
    if (!item) return;
    const proof = event.target.closest("[data-label-proof]");
    if (proof) openRuleEditor(proof.dataset.labelProof, null, null, item);
    else if (event.target.closest("[data-label-edit]")) openPicker(item);
    else if (event.target.closest("[data-label-auto]")) runAI(item, "auto");
  });
})(window.PR);
