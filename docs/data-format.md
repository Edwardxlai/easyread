# 数据格式

## paper.json

```json
{
  "schema": 2,
  "meta": {
    "title_zh": "给评测加上误差条：语言模型评测的统计学方法",
    "short_zh": "给评测加上误差条",
    "title_en": "Adding Error Bars to Evals: ...",
    "authors": "Evan Miller", "affiliation": "Anthropic",
    "date": "2024 年 11 月 4 日", "arxiv": "arXiv:2411.00640v1 [stat.AP]",
    "pdf": "source.pdf", "source_sha256": "…", "pages": [{"n": 1, "w": 612, "h": 792, "img": "pages/page-001.webp"}]
  },
  "translation": { "scope": "全文", "done_pages": [1, 2, 3], "note": "参考文献保留原文" },
  "glossary": [{ "en": "standard error", "zh": "标准误", "note": "可选" }],
  "references": [{ "id": "1", "text": "原文条目" }],
  "blocks": [ … ]
}
```

`translation.en_pages`：用“只读原文”整理过、还没翻译的页（这些页的块只有 `en`，没有 `zh`；页面直接排英文）。翻译它们时就地补 `zh`，块 id 不变，补齐的页从 `en_pages` 去掉。`done_pages` 包含这些页。

`meta.pages`、`page_count`、`source_sha256`、`pdf` 由导入时写，不要手改。文献库页里改的标题、作者等存在 `item.json` 的 `meta_override`，不改 paper.json。

### 块

每块必须有唯一 `id`（后续讨论、笔记都锚在它上面，定下后不要改）、`type`、`page`（这块在原 PDF 从哪页开始）。

| type | 字段 | 说明 |
|---|---|---|
| `heading` | `level`(1/2)、`num`、`zh`、`en`、`appendix` | 章节标题。`num` 如 "2.1"、"A"；附录的标题加 `"appendix": true` |
| `para` | `zh`、`en`、`role`、`cont` | 段落。`role: "abstract"` 用摘要样式；`cont: true` 表示接着公式的半句（如 “其中 …”） |
| `list` | `ordered`、`items: [{zh, en}]` | 列表 |
| `math` | `tex`、`tag` | 行间公式。`tag` 是原文编号（"1"），无编号不写。多行用 `aligned` / `gathered` |
| `table` | `num`、`head: [[…]]`、`rows: [[…]]`、`align`、`caption_zh`、`caption_en`、`caption_pos` | 表格。单元格支持行内标记，`\n` 换行（第二行括号内容自动变灰，适合“均值\n(标准误)”）。`align` 如 "lrrr" |
| `figure` | `num`、`src`、`box`、`image_en`、`image_zh`、`caption_zh`、`caption_en` | 图。`src` 是论文目录下的图片（如 `figures/crop-4-….webp`），留空时页面显示“图见原文第 N 页”。`box`、`image_*` 见下文“图：裁图和图内文字” |
| `references` | `zh`、`en` | 放参考文献列表的位置（内容取 `references`） |
| `note` | `zh` | 正文流里的“阅读批注（非原文）”。尽量不用，解释放 discussion.json |

可选 `box: [x0, y0, x1, y1]`（按页宽高归一化）手工指定原页高亮区域，覆盖自动定位。

图块可额外带 `translated_image: {src, source, target, image_en, image_zh}`，由图片编辑步骤写入。`src` 是生成的 WebP 相对路径；`source` 是原图路径；其余字段记录生成时的目标语言及图内文字。原图仍保存在块的 `src`，文字译文仍在块的 `image_zh`。生成时优先采用 `reader.json` 中的文字修订作为参考，不改写修订或原稿。只有记录与当前原图、语言及有效文字一致时，阅读页才显示译图；否则显示原图和文字译文。可用译图与原图沿用正文的单语／双语选择和双语顺序，不再展示图内文字译文；图注仍按正文设置显示。图片加载失败时恢复原图和文字兜底。生成失败不改变页面的翻译完成状态，失败原因写入 `job.log`。取消后不采用迟到结果，不自动重发图片请求。重新裁图或修改文字后，已有译图文件保留，但不再显示；可单独重新生成译图。

`config.json` 的 `figure_images.enabled` 开启译图，`provider` 默认为 `codex`，通过独立的 `codex exec` 调用内置生图，强制 ChatGPT 登录、忽略用户 API 配置，并移除子进程中的 API Key 环境变量。该步骤与仅返回文字的翻译调用分开；在临时目录接收并验证图片后，再由翻译流程写回文献库。`provider: "api"` 仅在用户主动选择图片 API 时使用，不作为 Codex 失败后的自动退路。

`POST /api/p/<id>/figure-images` 创建只处理图片的任务，提交和开始执行时均要求 `figure_images.enabled` 开启。阅读页从 `state/versions` 读取 `figure_images_enabled` 控制操作入口，设置保存后立即更新，其他标签页通过轮询同步；已有译图的展示不受此开关影响。省略 `ids` 时选取当前论文所有已有原图的图块；`ids: [块id, …]` 指定单张或多张图片，`force: true` 强制重做已有有效译图。任务沿用论文队列、互斥和取消功能，`job.type` 为 `figure-images`，`figure_ids` 保存选定范围，`image_failed` 按块 ID 记录失败原因，`done/total` 单位为张。本文入口默认补齐，单图入口默认强制重做。已在执行的译图任务遇到服务重启时标记中断，保留已保存的结果，等待用户手动补齐，避免未知远端结果被自动重复调用；尚未开始的排队任务可继续。

浮动体（表、图）放在正文第一次提到它的段落之后，`page` 仍写它实际所在页。

新增一批块（`easyread blocks ID --from 批次.json --done 4-6`）时可带 `"_after": "某块id"` 指定插入位置，否则追加到末尾；同 id 的块整块替换。

### 行内标记（zh、en、单元格、讨论正文通用）

- `$...$` 行内公式（KaTeX）；字面美元符写 `\$`
- `**粗体**`、`*斜体*`、`` `代码` ``
- `[7]`、`[2, 5]` 自动链到参考文献
- 中文里的“公式 (4)”“公式 (9) 和 (10)”“表 2”“图 3”“第 2.2 节”“附录 A”，英文里的 “Equation 4”“Table 2”“Section 2.2”“Appendix A”，自动变成可悬停预览、点击跳转的链接（目标要存在）
- 讨论正文里空行分段；单独一段 `$$...$$` 是行间公式

JSON 里 TeX 的反斜杠要写两个（`\\frac`）。`\f` `\b` `\t` `\n` `\r` 开头的命令（`\frac`、`\bar`、`\text`、`\nu`、`\right`）写错会被 JSON 悄悄吃掉，`paper.py check` 会报“含控制字符”。

## discussion.json

```json
{ "schema": 2, "entries": [
  { "id": "d001-ab12c", "anchor": "s2-1-p4", "quote": "对它（即“真实”的平均评测分数）进行推断",
    "kind": "check", "title": "原句漏了一个符号", "body": "…", "at": "…" }
]}
```

| 字段 | 说明 |
|---|---|
| `anchor` | 块 id；不写表示整篇（显示在题头旁） |
| `quote` | 可选，锚点块**译文**里的一段原话（纯文字，不能含 `$` 公式），页面会给它加下划线 |
| `kind` | `explain` 解释 / `qa` 问答 / `insight` 感悟 / `reply` 回复用户问题 / `check` 原文核对提示 |
| `title`、`q`、`body` | 标题、问题（问答用）、正文（必填，支持行内标记） |
| `reply_to` | 回复用户笔记时填笔记 id（`easyread status` 里能看到），锚点自动跟随那条笔记 |

用 `easyread discuss ID --from 文件.json` 追加（数组或单个对象）；带已有 `id` 是修改；`--delete ID` 删除。`id`、`at` 不写会自动生成。

## reader.json（只读）

```json
{ "rev": 12,
  "edits": { "s1-p3": { "zh": "用户版本", "base": "改时译者稿的哈希", "at": "…" },
             "tab1#caption": { … }, "s1-recs#2": { … } },
  "notes": { "n…": { "id": "n…", "anchor": "s1-p2", "key": "s1-p2", "quote": "…", "prefix": "…", "suffix": "…",
                    "kind": "note | question | highlight", "color": "yellow | green | blue | pink",
                    "body": "…", "created": "…", "updated": "…", "deleted": false } },
  "paper_note": { "body": "整篇的论文笔记", "at": "…" },
  "progress": { "block": "s3-1-p2", "off": 0.4, "ratio": 0.35, "at": "…" } }
```

读到哪儿：`block` 是视口上部 30% 那条线穿过的块，`off` 是那条线在这个块里占的比例（块有几屏高时靠它落回原处），`ratio` 是全文比例，文献库列表上的百分比用它。1.4.2 及以前只有 `block` 和 `ratio`。

编辑的键：普通块是块 id，表/图题注是 `id#caption`，列表项是 `id#序号`。页面只通过 `/api/p/ID/ops` 发操作（`edit`、`note`、`note_del`、`paper_note`、`progress`），每个操作幂等、带时间戳，同一对象以较新的为准；服务端加锁、原子写、记日志。离线版导出的修改用 `easyread merge ID --from 导出.json` 并回。

## item.json（只读）

```json
{ "added": "…", "tags": ["统计"], "status": "unread | reading | done", "starred": false,
  "last_opened": "…", "meta_override": { "title_zh": "…" } }
```

## job.json（后台任务状态）

`{"type": "translate", "state": "queued | running | done | partial | error | cancelled", "message": "…", "done": 4, "total": 14, "error": "", "failed": {"7": "原因"}, "scope": "all | body | first:N"}`。服务重启后 queued / running 的任务会自动继续。`partial` 表示有页没译成功（`failed` 里是页码和原因），页面上可以一键重试。每篇的翻译过程记在 `job.log`。

## layout.json（自动生成的原页定位）

```json
{ "s1-p3": {
  "page": 1, "src": "text", "box": [0.08, 0.10, 0.92, 0.90],
  "boxes": [[0.08, 0.60, 0.48, 0.90], [0.52, 0.10, 0.92, 0.30]]
} }
```

每个坐标框都是按原页宽高归一化的 `[x0, y0, x1, y1]`。跨栏段落的可选 `boxes` 保存各栏的独立区域，按从左到右排列；原页高亮和点击定位逐个使用这些区域，保留栏间空白。`box` 保留整体外接框以兼容旧数据；没有 `boxes` 时只使用 `box`。图表仍使用包含图像的完整区域。

服务首次打开已有文献时会用本地字符坐标重算定位，无需重新翻译；离线导出会包含同样的定位数据和高亮逻辑。

## chat.json（“问 AI”的对话记录，只有服务写）

```json
{ "threads": [
  { "id": "t…", "title": "我标红的那些公式有什么联系", "model": "opus", "created": "…", "updated": "…",
    "messages": [
      { "role": "user", "content": "…", "anchor": "s1-recs", "quote": "", "note": null, "at": "…" },
      { "id": "m…", "role": "assistant", "content": "……", "model": "Claude Opus 5", "anchor": "s1-recs", "note": null, "at": "…" } ] } ] }
```

一篇论文可以有多个对话。`note` 不为空时，这次是在回答页边那条笔记里的问题，回答同时写进 discussion.json（`reply_to` 那条笔记，`live: true`）。“放到页边”把一条回答写成 discussion.json 里的 `qa` 条目。提问时会把读者的全部标记（按颜色分组）一起交给模型。

## 数据目录里的其他文件

| 文件 | 内容 |
|---|---|
| `config.json` | 设置：翻译引擎、各家 API Key（`openai.keys`，按服务商分开存）、问 AI 的模型名单和默认模型（`chat.models`、`chat.default`） |
| `prefs.json` | 界面偏好：阅读页字号、版心、主题、划线笔（`reader`），功能开关和快捷键总开关（`ui`），改过的键位（`keys`） |
| `easyread.log` | 服务日志，设置底部“查看运行日志”能看到 |

## 图：裁图和图内文字

- `box` 是模型给的图本身的归一化裁剪框 `[x0, y0, x1, y1]`，不含题注。翻译和只读原文整理都在合并锁里、块 id 最终去重之后才按 `box` 裁图，所以并发批次撞了 id 也不会指到别人的图
- 截图文件名是 `figures/crop-<页>-<哈希>.webp`，哈希包含页码、裁剪框和 PDF 文件身份：重译改了框会换新文件，不会沿用旧图或浏览器缓存。裁图失败就清掉 `src` 和 `box`，保留原页入口
- 没有 `box` 的图块（模型没给，或旧论文）：打开阅读页时后台按原页定位（layout.json）里的图区域补截，这个区域包含题注
- `image_en` 是图内可读文字原文，`image_zh` 是目标语言的译文（字段名沿用历史叫法），在图下单独显示，不改图片像素。只读原文先显示 `image_en`，补译时按 `id#image` 写入，编辑和重译用同一个键
- 旧论文不会自动调模型补提取图内文字；要重新整理对应页，或由 agent 核对原页后补上

## 为什么用 JSON 文件而不是数据库

EasyRead 是个人工具：一个人、一台电脑、几十到几百篇论文。每篇一个文件夹、几个 JSON，好处是能直接看、能直接备份和同步（网盘、git 都行），agent 在对话里也能直接读写；按“谁写哪个文件”分开之后，也不需要数据库的并发控制。文献库列表每次扫描各文件夹生成，几百篇以内是毫秒级。浏览器 localStorage 只用来暂存还没写进文件的修改和缓存偏好，不是数据的正本。
