/* Documents are read into the draft and sent only with its question. */
(function (PR) {
  "use strict";
  PR.createChatDocuments = function (st, panel, render) {
    let generation = 0;
    Object.assign(st, { documents: [], fileLoading: false, fileError: "" });

    async function add(files) {
      if (!files.length || st.streaming || st.fileLoading || !PR.canChat()) return;
      const ticket = generation;
      st.fileLoading = true;
      st.fileError = "";
      render();
      try {
        if (st.documents.length + files.length > 2) throw Error(PR.t("每次最多添加 2 个文件"));
        const pending = [];
        for (const file of files) {
          if (!/\.(pdf|txt|md)$/i.test(file.name)) throw Error(PR.t("请选择 PDF、TXT 或 Markdown 文件"));
          if (file.size > 8 * 1024 * 1024) throw Error(PR.t("每个文件最多 8 MB"));
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(Error(PR.t("文件读取失败")));
            reader.readAsDataURL(file);
          });
          if (ticket !== generation) return;
          pending.push({ name: file.name, data });
        }
        st.documents.push(...pending);
      } catch (error) {
        if (ticket === generation) st.fileError = error.message;
      } finally {
        if (ticket === generation) { st.fileLoading = false; render(); }
      }
    }

    panel().addEventListener("change", event => {
      if (event.target.id === "chatFileInput") add(Array.from(event.target.files));
    });
    function html(files, draft) {
      return files.map((file, i) => {
        const name = PR.esc(file.name) + (file.truncated ? PR.t("（节选）") : "");
        return '<span class="ch-document">' + name + (draft ? ' <button type="button" data-c="unfile" data-i="' + i +
          '" aria-label="' + PR.esc(PR.t("移除附件")) + '">×</button>' : '') + '</span>';
      }).join("");
    }
    return { add, html, reset() { generation++; st.documents = []; st.fileLoading = false; st.fileError = ""; } };
  };
})(window.PR);
