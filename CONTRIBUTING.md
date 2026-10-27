# 参与贡献

欢迎提 Issue 和 PR。下面是一些约定，照着来能更快合并。

## 本地跑起来

需要 Python 3.10+。

```bash
git clone https://github.com/Edwardxlai/easyread
cd easyread
python -m pip install -e .
easyread
```

浏览器会打开 `http://127.0.0.1:8765`。也可以直接用 `start.cmd`（Windows）或 `./start.sh`（macOS / Linux）。

改桌面版（Electron）还需要 Node.js 22+，见 README 的“桌面版”一节。

论文笔记的 Tiptap 工具栏源码在 `easyread/web/src/note-toolbar.tsx`，编辑器与 Markmap 集成在 `easyread/web/js/reader/paper-note-editor.js`。修改 `src/` 后运行 `npm ci`（首次安装依赖）和 `npm run build:editor`，刷新阅读页查看效果。`npm run dist` 会先构建编辑器资源，再打包桌面程序。

macOS 开发时可用 `node --watch-path=easyread/web/src scripts/build_note_editor.cjs` 监听源码，保存后自动编译；浏览器使用强制刷新加载新的资源。

## 跑测试

```bash
python -m unittest discover tests -v
node --test tests/web/test_*.cjs tests/desktop/test_*.cjs
```

提 PR 后 GitHub Actions 会在 Windows、macOS、Linux 上自动跑一遍。第一次贡献的 PR 需要维护者点一下批准才会开始跑，稍等就好。

## 提 PR

- 一个 PR 只做一件事，方便审和回退。
- 标题和说明写清楚改了什么、为什么改；修 bug 的话写一下怎么复现。
- 改了界面的，附一张截图。
- 修了 bug 或加了功能，尽量在 `tests/` 里补一个测试。
- 不用改 `CHANGELOG.md` 和版本号，发版时维护者统一写。

## 界面文字

界面跟着系统语言显示中文或英文。写代码时只写中文，外面套一层：前端 `PR.t("已导入 {n} 篇", { n })`，后端 `tr("已导入 {n} 篇", n=n)`。英文写在 `easyread/web/i18n/en.json`，缺了的话测试会报出来；不方便写英文就在 PR 里说一声，维护者来补。

`python scripts/i18n_check.py` 会列出没套 `PR.t` / `tr` 的中文和缺英文的词条。确实不该翻译的中文（比如给模型的提示词），在那一行末尾加注释 `i18n-ok`。

## 报问题

直接开 Issue 就行，有模板提示要写哪些信息，填不全也没关系。
