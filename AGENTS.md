# EasyRead 开发入口

EasyRead 帮读者从一篇论文进入正文、核对原文、做笔记并回到原句。接到反馈先找到目标版本的实际入口。维护 issue、审 PR 和准备版本时，按[维护流程](maintenance/triage.md)和[已定范围](maintenance/decisions.md)判断。

| 要改的行为 | 代码归属与约定 |
| --- | --- |
| 阅读布局 | `easyread/web/css/base.css` 管共享视觉，`reader.css` 管正文。沿用约 35em 版心、1.9 行距，尊重已有阅读偏好。桌面和窄屏分别检查侧栏、锚点和溢出，细节见[阅读设计](docs/design.md) |
| 阅读交互、文献库 | HTML、CSS、原生 JS。段落动作跟随段落，论文操作归论文菜单。新入口和快捷键调用同一现有行为，开关放 `easyread/web/js/common/features.js`。修改阅读器脚本同时考虑离线导出 |
| 笔记编辑 | 局部使用 React、Tiptap、esbuild。改 `easyread/web/src/` 后运行 `npm run build:editor` 并同步编译产物 |
| 本地服务、翻译、数据 | Python 3.10+。HTTP 入口在 `easyread/server/`，领域行为在 `bulk/`、`pdf/`、`translate/`、`chat/`、`export/`。模型能力与调用归 `engines/`，文献、批注、续跑记录归 `library/`。变更同步[接口](docs/api.md)或[数据格式](docs/data-format.md) |
| 桌面 | Electron 管窗口、原生菜单、安装与更新，Node 22 用于开发和构建。阅读行为沿用 Web 实现。安装包通过 PyInstaller、electron-builder 在各平台原生构建 |

新增功能沿现有调用路径落到所属模块。修改超过 400 行的通用入口时拆出独立职责。用户操作变化同步双语指南，版本号与 CHANGELOG 由发布者汇总。样本、草稿和交接留在本机。

开发、隔离预览和按改动选择测试见[贡献指南](CONTRIBUTING.md)。发布候选和实际安装验证见[桌面发布](maintenance/release.md)。
