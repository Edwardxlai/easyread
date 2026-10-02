<p align="center">
  <img src="docs/images/logo.svg" width="72" alt="EasyRead">
</p>
<h1 align="center">EasyRead</h1>
<p align="center"><b>把英文论文，读成舒服的中文。</b><br>
导入 PDF，后台逐页翻译；公式、表格照原文排好，随时对照原文，边读边划线、记笔记、提问。<br>
本地运行，论文和笔记只存在你自己的电脑上。</p>

<p align="center"><b>简体中文</b> · <a href="README.en.md">English</a></p>

<p align="center"><a href="https://edwardxlai.github.io/easyread/demo/"><b>▶ 在线试读一篇</b></a> · <a href="https://edwardxlai.github.io/easyread/">项目主页</a> · <a href="https://github.com/Edwardxlai/easyread/releases/latest">下载</a></p>

<p align="center">
  <a href="https://github.com/Edwardxlai/easyread/releases/latest"><img src="https://img.shields.io/github/v/release/Edwardxlai/easyread?label=%E7%89%88%E6%9C%AC" alt="版本"></a>
  <a href="https://github.com/Edwardxlai/easyread/actions/workflows/test.yml"><img src="https://github.com/Edwardxlai/easyread/actions/workflows/test.yml/badge.svg" alt="测试"></a>
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-本地运行-2f6070" alt="平台">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT">
</p>

<p align="center"><img src="docs/images/pages.jpg" width="860" alt="译文和原页对照"></p>

## 它和“把 PDF 丢给翻译软件”有什么不一样

- **像读一本排好版的中文书。** 宋体正文、舒服的行宽和行距，公式用 KaTeX 按原文重排，表格是三线表，参考文献保留原文。顶栏一键切深色。
- **随时核对原文。** 一键切“对照”，每段下面附英文；右侧可以开原页，跟着阅读位置翻页，还会框出当前段落在原页的位置。
- **翻译和解释分开。** 正文只放忠实的译文；AI 的解释、回答放在页边，一眼就能分清哪句是论文说的。
- **边读边问 AI。** 右侧“问 AI”面板实时对话，回答逐字流出来；可以一次引用好几段（选中文字拖进输入框就行）。问“我标红的那些公式有什么联系”，它会按颜色找出你的划线。可以开多个对话，模型单独选：Claude、GPT（Codex）、DeepSeek、通义、本机 Ollama……好的回答一键放到页边。
- **ASD-STE100 问答。** 在“问 AI”的“回答方式”里选择这个模式，用简明语言回答问题或总结论文，保留专业术语、公式和数值。新对话选择 STE 时默认开启“中英文对照”，中文在上，英文在下；关闭开关则仅输出中文。两个版本需保留相同的条件、范围和不确定性。模式按对话保存，已有中文对话保留原设置。支持复制、放到页边和导出 Markdown。[ASD-STE100](https://www.asd-ste100.org/STE_faq.html) 是英文标准；这个模式借鉴其短句、主动表达和术语一致等原则，提供写作辅助，不将答案标为已通过完整标准或词典核查。正文过长时只提供节选，回答需说明依据范围。
  中文提示词另参考 [asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill) 的语义保留原则：保留条件、范围和“可能／建议／必须”等语气强度，不为简短而丢失精度。
  [查看中英文对照界面](docs/images/ste100-bilingual-chat.png)。截图使用合成示例。
- **边读边批注。** 选中文字四色荧光笔或下划线、写笔记、提问；问题一键让 AI 回答，笔记可以让 AI 点评。所有笔记按原文顺序汇总，可以勾选导出成 Markdown（放进 Obsidian、Notion）。
- **译文可以改。** 双击一段直接改；术语表里改一个译法，全文替换。
- **不只是 arXiv。** 拖进任何 PDF；或者填 arXiv 编号、DOI、论文标题、论文网页（OpenReview、ACL、NeurIPS、bioRxiv、PMC、期刊页面），自动找到公开的 PDF 并补全作者、年份、出处。
- **文献库。** 侧栏像聊天软件：论文和分类都能置顶；自己建分类（右键改名、删除，把论文拖进去），内置分类可以隐藏；最近阅读、搜索、未读 / 在读 / 已读、星标、阅读进度、复制引用（GB/T 7714、APA、BibTeX）、导出单文件离线 HTML 发给别人。删掉的论文先进回收站，可以恢复。快捷键可以自定义。
- **用了多少心里有数。** 每次翻译、每条 AI 回答都记下用了多少 token；用 Claude 订阅时，还能看到 5 小时 / 7 天额度用到多少、什么时候重置。
- **不会丢东西。** 每次修改先存在浏览器，本地服务确认写进文件才删；翻译方后来改了你改过的段落，只提示，不覆盖。

<p align="center"><img src="docs/images/chat.jpg" width="860" alt="边读边问 AI"></p>

<p align="center"><img src="docs/images/library.jpg" width="860" alt="文献库"></p>

## 翻译用什么模型：你来选

| 引擎 | 要什么 | 说明 |
|---|---|---|
| **Claude Code**（推荐） | 装好并登录 [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) | 不用 Key，用你订阅的额度；会自己看原页图核对公式，译文最好 |
| **Codex CLI** | 装好并登录 [Codex](https://github.com/openai/codex) | 不用 Key，用 ChatGPT 账号 |
| **API 接口 · 国内直连**：DeepSeek / 智谱 / 阿里云百炼 / Kimi / 硅基流动 / 魔搭 | API Key | 智谱 GLM-4.7-Flash、硅基流动小模型免费；DeepSeek 一篇 20 页论文几毛钱 |
| **API 接口 · 海外（要梯子）**：OpenAI / Anthropic / Gemini / OpenRouter / Groq / Cerebras | API Key | Gemini、OpenRouter、Groq、Cerebras 有免费额度 |
| **API 接口 · 本机**：Ollama / LM Studio | 本机装 [Ollama](https://ollama.com) 或 [LM Studio](https://lmstudio.ai) | 完全离线、免费，推荐 qwen3.5:9b（显卡小用 4b） |
| **API 接口 · 自定义地址**：任意 OpenAI 兼容接口、中转站 | 地址 + Key | Chat Completions 和 Responses 两种格式都支持；点“获取模型列表”从接口拉模型名 |

不想让它导入后马上翻译，在设置里关掉“导入后自动开始翻译”就行，之后可以让对话里的 agent 来译。

设置里会自动检测本机装了什么，点“试译一句”马上知道能不能用。某一页翻译失败（限流、网络、额度）会自动重试，还不行就先跳过、接着译后面的页，最后一键“重试失败的页”。

<p align="center"><img src="docs/images/settings.jpg" width="640" alt="设置"></p>

## 安装

**最省事：下载安装包**（不用装 Python）。在 [Releases](https://github.com/Edwardxlai/easyread/releases/latest) 下载：

- **Windows**：`EasyRead-Setup-x.x.x.exe`，双击安装。没有代码签名，如果弹出“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”。
- **macOS**（Apple 芯片）：`EasyRead-x.x.x-arm64.dmg`，把 EasyRead 拖进“应用程序”。第一次打开会提示“无法验证开发者”：去“系统设置 → 隐私与安全性”，在下面点“仍要打开”，之后就正常了。
- **Linux**：`EasyRead-x.x.x.AppImage`，`chmod +x` 后运行。

安装版的论文和设置存在用户目录下的 `EasyRead` 文件夹（和 pip 安装版同一个位置），卸载重装不会丢。

**或者从源码运行**：需要 [Python 3.10+](https://www.python.org/downloads/)。

先从 [Releases](https://github.com/Edwardxlai/easyread/releases/latest) 下载最新版的 zip 解压（或者 `git clone` 本仓库）。

**Windows**：双击 `start.cmd`。第一次会自动装好环境（一分钟左右），之后双击直接打开。

**macOS / Linux**：在解压出来的目录里运行

```bash
./start.sh
```

这样启动的，浏览器里的 EasyRead 页面全部关掉后，后台服务过十几秒会自己退出；还有翻译在跑的话，等译完再退。

每次推送都会在 Windows、macOS、Linux 上自动装一遍、跑测试、启动一次（见上面的“测试”徽章）。

**或者用 pip**（数据放在 `~/EasyRead`）：

```bash
pip install git+https://github.com/Edwardxlai/easyread
easyread
```

浏览器会打开 `http://127.0.0.1:8765`。服务只监听本机。

## 桌面版（Electron）

桌面版复用同一套本地 Python 服务和 Web 界面，由 Electron 负责启动服务并显示窗口。开发环境需要 Node.js 22+、Python 3.10+ 和 PyInstaller：

```bash
npm install
python -m pip install pyinstaller
npm run dev
```

生成可分发安装包：

```bash
npm run dist
```

输出在 `dist/electron/`：Windows 为 NSIS 安装程序，macOS 为 DMG，Linux 为 AppImage。推送 `v*` 标签后，GitHub Actions 会在三个系统上构建，并把这些安装包自动附加到 GitHub Release；源码 zip 仍会由 GitHub 保留。打包后的文献库和设置保存在系统的 EasyRead 用户数据目录中，不会写进安装目录。

## 怎么用

1. 右上角“设置” → “模型”：添加要用的模型，点卡片选“设为翻译”。翻译和“问 AI”用的模型都在这一页管理。
2. 把 PDF 拖进窗口；或者粘贴 arXiv 编号、arXiv / OpenReview 链接、PDF 直链（在文献库页面直接 `Ctrl+V` 也行）。长论文可以选“只译正文”，或者“指定页”只译第几页到第几页。导入时还能选这次用哪个模型；“导入后”选“读英文原文”就只排版、不翻译，想看中文了随时点“翻译成中文”。
3. 翻译在后台一页页进行，已译的部分马上能读，没译到的页先显示原页。
4. 读的时候点一下段落出现操作条；选中文字可以划线、写笔记、提问。按 `?` 看全部快捷键。

## 和 AI agent 一起读

EasyRead 自带命令行，Claude Code / Codex 这类 agent 可以在对话里直接读你的笔记和问题、把回答写到对应段落旁边，也可以亲自翻译或重译某几页。技能说明在 [`skill/paper-reading/SKILL.md`](skill/paper-reading/SKILL.md)，把这个目录放进 `~/.claude/skills/` 或 `~/.codex/skills/` 即可。

```bash
easyread list                          # 列出文献库
easyread import 论文.pdf                # 或 arXiv 编号 / 链接
easyread status ID                     # 进度、我改过的译文、笔记、待回答的问题
easyread discuss ID --from 回答.json    # 把讨论写到页边
easyread export ID                     # 导出单文件离线 HTML
```

完整命令见 `easyread --help`，数据格式见 [docs/data-format.md](docs/data-format.md)。

## 常见问题

**翻译到一半失败了？** 文献库里点这篇，右侧“翻译”一栏会写原因和失败的页，点“重试”。“翻译记录”里有每一批的详细情况；设置底部“运行日志”能看到服务本身的日志。

**用 Claude Code 要挂梯子吗？** 和你平时在终端里用 `claude` 一样：平时要，这里也要。不想折腾就在设置的“API 接口”里选智谱、硅基流动（都有免费模型）或本机 Ollama，国内直连。

**Claude Code 额度用完了？** 等额度恢复后点“重试”，或者在设置里临时换成 API / Ollama，已经译好的页不会重译。

**数据存在哪？** 全在本机。从源码运行时在项目目录的 `library/`；pip 安装后在 `~/EasyRead/library/`。每篇论文一个文件夹，里面是原 PDF、原页图和几个 JSON（译文、你的笔记、AI 讨论、对话记录），设置和界面偏好在 `config.json`、`prefs.json`。可以直接备份或同步。为什么不用数据库见 [docs/data-format.md](docs/data-format.md#为什么用-json-文件而不是数据库)。

**能离线看、发给别人吗？** 能。文献库里右键一篇论文 → “导出离线 HTML”，得到一个单文件网页（命令行是 `easyread export ID`）。对方不用装 EasyRead，双击用浏览器打开就能读：译文、公式、原页图、你的划线和笔记都在里面，也能切对照、开原页、接着划线。原页图是打包进去的，所以文件不小（27 页的论文约 10 MB）。在离线版里新做的划线和笔记只存在打开它的那个浏览器里；想并回文献库，在左侧“说明”里点“导出我的修改”得到一个 JSON，再运行 `easyread merge ID --from 导出.json`。

想放到网站上（比如 GitHub Pages），用 `easyread demo ID --out 目录`：图片另存成文件、按需加载，还会带上问 AI 的对话记录（只能看）。

## 开发

没有前端构建：`easyread/web/` 下是纯 HTML/CSS/JS，改完刷新即可。后端只用 Python 标准库加 PDF 处理库。

```bash
python -m unittest discover tests         # 翻译调度等单元测试
node tests/e2e.cjs library/<论文ID>       # 浏览器端到端测试（需要 Playwright 和一篇已译好的论文）
```

设计取舍见 [docs/design.md](docs/design.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT。公式渲染用 [KaTeX](https://katex.org)（MIT）。

在线演示用的论文是 Rafailov 等人的 *Direct Preference Optimization: Your Language Model is Secretly a Reward Model*（[arXiv:2305.18290](https://arxiv.org/abs/2305.18290)，CC BY 4.0），中文译文由 EasyRead 调用 Claude 生成，演示里的划线和笔记是示例。

## 贡献者

- [@Wang-auspicious](https://github.com/Wang-auspicious) — Electron 桌面版打包与发布流程
- [@bisuwuss-netizen](https://github.com/bisuwuss-netizen) — 修复桌面安装包漏打 PDF 依赖、双栏论文原页定位；“问 AI”和笔记里的 Markdown 表格与引用块
- [@MeshedPoto](https://github.com/MeshedPoto) — 并行翻译时 PDFium 随机报错、跨栏段落原页高亮、macOS 桌面版稳定性、HTTPS 证书与流式回答的一批修复
