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
| GET | `/api/library` | 文献库列表 `items`、可用标签列表 `labels` 和写操作要用的 `token`。每篇的 `labels` 列出它当前的标签 |
| GET | `/api/library/labels` | 读取可用标签的 `labels` 数组，每项包含 `name` 和 `rule`。可用 `?name=标签名` 只读取一个标签，未找到时返回空数组。空规则使用标签名判断 |
| POST | `/api/library/labels` | 传 `{"name": "研究方法"}` 新建可复用的标签。返回保存的标签名 `name` |
| POST | `/api/library/labels/rule` | 传 `name` 和 `rule` 修改已有标签的全库规则。可传打开编辑器时的 `previous_rule`，如规则已被改成其他内容，保存会返回错误。成功时返回保存的名称和规则 |
| POST | `/api/p/{id}/labels` | `add` 和 `remove` 分别接收要添加和移除的标签名数组。可用 `new_rules` 提供本次创建的标签规则，键是标签名。返回本篇的 `labels` 和这次新增的 `added` |
| POST | `/api/p/{id}/labels/auto` | 使用默认问答模型按规则匹配已有标签，返回实际新增的 `added` 数组 |
| POST | `/api/p/{id}/labels/suggest` | 预览最多三个 AI 建议的标签。`suggestions` 数组每项包含 `name` 和 `rule`。勾选的建议通过论文标签接口的 `add` 和 `new_rules` 一起保存 |
| POST | `/api/p/{id}/labels/generate` | 使用默认问答模型生成最多三个可复用标签及规则，保存并应用到本篇。返回实际应用的新标签 `added` |
| POST | `/api/import?name=<文件名>&translate=0\|1` | 请求体是 PDF 原始字节，请求头带 `X-Token`。返回 `{"id", "new", "queued"}`；已有同一 PDF 时 `new` 为 false |
| GET | `/api/p/{id}/part/paper` | `{"data": paper.json, "version": …}`：标题、段落原文和译文 |
| GET | `/api/p/{id}/part/reader` | `{"data": reader.json, "version": …}`：划线、批注、整篇心得 |
| GET | `/api/p/{id}/part/discussion` | `{"data": discussion.json, "version": …}`：保存到页边的 AI 回答 |
| GET | `/read/{id}` | 阅读页，可加 `#段落id` 定位 |
| GET | `/open?sha256=<完整 SHA-256>&block=<段落 id>` | 按指纹打开论文；也可用 `id=<论文 id>`。找到就跳到阅读页，找不到回文献库 |

`/api/p/{id}/state` 是阅读页自己用的：会把论文标记成"打开过"、触发补图，外部工具读数据请用上面的 `part/*`。

写操作（POST）都要带 `X-Token` 请求头，值从 `/api/library` 取；token 每次启动都会变。

## 桌面版打开链接

桌面版（1.3.1 起）注册了 `easyread://` 协议：

```
easyread://open?sha256=<完整 SHA-256>&block=<段落 id>
easyread://open?id=<论文 id>
```

点击后打开（或唤起）EasyRead 窗口并定位到该段落，参数含义同 `/open`。参数只接受字母、数字、`-`、`_`，其余内容会被忽略。没装桌面版时，用浏览器打开 `<url>/open?...` 效果相同。

## 数据格式

`part/*` 返回的 JSON 结构见 [data-format.md](data-format.md)。其中字段只会增加，不会改名或改含义；改了算不兼容，按上面的规则升 API 版本。
