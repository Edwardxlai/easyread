# 本机接口约定（给外部工具）

Zotero 插件、脚本等外部工具接入 EasyRead 时，只依赖本页列出的接口。这些接口保持兼容；不兼容的改动会把 API 版本加 1，并提前写进 CHANGELOG。本页没列的 `/api/*` 都是界面内部用的，随时可能改。

当前 API 版本：**1**（EasyRead 1.3.1 起）。

## 找到服务

EasyRead 运行时把地址写在数据目录的 `.server.json`（默认 `~/EasyRead/.server.json`，设置了 `EASYREAD_HOME` 时在那个目录下）：

```json
{ "url": "http://127.0.0.1:52341", "pid": 12345, "started": "2026-10-03T12:00:00Z" }
```

端口每次启动可能不同，不要写死。服务只监听 `127.0.0.1`。读到地址后先请求 `/api/version` 确认服务还活着、版本是否支持。

## 论文怎么标识

- **论文 id** = 原 PDF 完整 SHA-256 的前 12 位（小写十六进制）。同一个 PDF 重复导入得到同一个 id，不会建第二篇。
- **段落 id** 是 `paper.json` 里块的 `id`（如 `p3-2`、`eq4`、`fig2`），定下后不变，见 [data-format.md](data-format.md)。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/version` | `{"api": 1, "version": "1.3.1"}`；`api` 是本页约定的版本，`version` 是应用版本 |
| GET | `/api/library` | 文献库列表 `items`（每篇的 `id`、标题、作者、DOI、进度、笔记数等）和写操作要用的 `token` |
| POST | `/api/p/<id>/chat` | 阅读器流式问答。可选 `library_scope` 为 `{}`（全库）、`{"category":"…"}` 或 `{"papers":[…]}`。检索后返回 `sources` 和 `missing` 事件，并保存到该条回答。省略或传 null 使用当前论文 |
| POST | `/api/library/ask` | 传 `query`；自动检索可附 `category`，手动选文献则传 `papers` ID 数组。返回回答、来源、用量和未提供正文的所选论文 |
| POST | `/api/p/{id}/suggest-categories` | 用默认问答模型生成分类候选；若已有待审建议，返回该建议 |
| POST | `/api/p/{id}/review-categories` | 传建议 `id` 和确认的 `categories` 数组，空数组表示跳过 |
| POST | `/api/import?name=<文件名>&translate=0\|1` | 请求体是 PDF 原始字节，请求头带 `X-Token`。返回 `{"id", "new", "queued"}`；已有同一 PDF 时 `new` 为 false |
| GET | `/api/p/{id}/part/paper` | `{"data": paper.json, "version": …}`：标题、段落原文和译文 |
| GET | `/api/p/{id}/part/reader` | `{"data": reader.json, "version": …}`：划线、批注、整篇心得 |
| GET | `/api/p/{id}/part/discussion` | `{"data": discussion.json, "version": …}`：保存到页边的 AI 回答 |
| GET | `/read/{id}` | 阅读页，可加 `#段落id` 定位 |
| GET | `/open?sha256=<完整 SHA-256>&block=<段落 id>` | 按指纹打开论文；也可用 `id=<论文 id>`。找到就跳到阅读页，找不到回文献库 |

`/api/p/{id}/state` 是阅读页自己用的：会把论文标记成"打开过"、触发补图，外部工具读数据请用上面的 `part/*`。

写操作（POST）都要带 `X-Token` 请求头，值从 `/api/library` 取；token 每次启动都会变。

文献库界面内部使用 `POST /api/p/{id}/match-category`，传入 `rule` 后用默认问答模型核对原文。返回状态为 `match` 时附可核对的 `quote`、`page` 和可用的 `anchor`；其余状态为 `no_match`、`no_source` 或 `excluded`。分析不写入文献库。读者确认后，界面通过既有的 `item` 操作传 `add_category`，在锁内追加分类。这两个界面操作不属于外部兼容接口。

## 桌面版打开链接

桌面版（1.3.1 起）注册了 `easyread://` 协议：

```
easyread://open?sha256=<完整 SHA-256>&block=<段落 id>
easyread://open?id=<论文 id>
```

点击后打开（或唤起）EasyRead 窗口并定位到该段落，参数含义同 `/open`。参数只接受字母、数字、`-`、`_`，其余内容会被忽略。没装桌面版时，用浏览器打开 `<url>/open?...` 效果相同。

## 数据格式

`part/*` 返回的 JSON 结构见 [data-format.md](data-format.md)。其中字段只会增加，不会改名或改含义；改了算不兼容，按上面的规则升 API 版本。

### 阅读字体与自动导入

`GET /api/fonts` 返回本机字体族名数组 `fonts`。文件夹的 `POST /api/migrate/scan` 返回 `watch`（未启用为 null）。`POST /api/migrate/watch` 接收绝对路径 `path`、布尔值 `enabled`，以及可选的 `link` 和 `keep_filename`。启用后会收取该目录已有和新增的完整 PDF，沿用普通分类；取消只停止监听。
