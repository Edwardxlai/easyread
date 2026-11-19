/* 映射文件夹和子文件夹复用文献库的分类树。 */
(function (PR) {
  "use strict";
  const L = PR.lib, T = PR.catTree, side = PR.$("#side");
  const library = PR.$(".lib"), sideButton = PR.$("#libraryNavBtn");

  function showSide(open) {
    library.classList.toggle("library-nav-open", open);
    sideButton.setAttribute("aria-expanded", String(open));
  }
  sideButton.innerHTML = PR.icon("book", "sm");
  sideButton.onclick = () => showSide(!library.classList.contains("library-nav-open"));
  document.addEventListener("click", (e) => {
    if (library.classList.contains("library-nav-open") && !e.target.closest("#side, #libraryNavBtn, #ctxmenu")) showSide(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && library.classList.contains("library-nav-open")) showSide(false);
  });

  function row(folder, kids, open) {
    const current = L.view === "folder" && L.tag === folder;
    return '<div class="srow tree' + (current ? " on" : "") + '" data-folder="' + PR.esc(folder) +
      '" tabindex="0" style="--lvl:' + T.depth(folder) + '" title="' + PR.esc(T.label(folder)) + '">' +
      PR.foldSlot(kids, open) + PR.icon("folder", "sm") + '<span class="t">' + PR.esc(T.leaf(folder)) +
      '</span><span class="n">' + L.items.filter((i) => L.inFolder(i, folder)).length +
      '</span></div>';
  }

  L.renderFolderTree = function () {
    sideButton.hidden = !L.folderSync.folders.length;
    if (sideButton.hidden) {
      if (library.classList.contains("library-nav-open")) showSide(false);
      return "";
    }
    return PR.sideTreeHtml(T.ordered(L.folderSync.folders), { catRow: row, tags: L.folderTags });
  };

  function select(folder) {
    L.tag = L.view === "folder" && L.tag === folder ? null : folder;
    L.view = L.tag ? "folder" : "all";
    showSide(false);
    L.render();
  }

  side.addEventListener("click", (e) => {
    const node = e.target.closest("[data-folder]");
    if (!node) return;
    const folder = node.dataset.folder;
    if (e.target.closest("[data-fold]")) return L.toggleFold("/" + folder);
    select(folder);
  });
  side.addEventListener("keydown", (e) => {
    const node = e.target.closest("[data-folder]");
    if (node && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); select(node.dataset.folder); }
  });
})(window.PR);
