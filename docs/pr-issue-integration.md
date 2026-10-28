# PR 与 issue 本地整合记录

基线：`ac031c7`（v1.4.5），原整合分支：`codex/pr-issue-integration`；1.4.6 汇总分支：`codex/release-1.4.6`

## 实现范围

- #118（本地已修改，完整翻译未验证）：取消 `--agent easyread-reader`、自定义 agent 配置和临时 agent 文件，改为 `opencode run --format json` 直接通过标准输入传入任务；保留用户模型与登录配置、工具权限限制和临时工作目录隔离。此前增加 agent 文件的候选方案已移除
- #121 / PR #122：清理替换后的自动裁图，保留共享引用和手动裁剪快照；补充完整相对路径、符号链接和目录边界检查，引用复核与删除使用论文写锁
- #114：保留原有目录抽屉，左上角 ☰ 或快捷键 T 展开，章节点击跳转；已按用户决定撤掉新增固定侧栏试验，并已回复现有功能入口
- 图片查看器：缩放工具栏中的弹性空白生效，关闭按钮靠右显示
- #116：正文 Ctrl / ⌘＋滚轮调字号，复用 Aa 的范围与阅读位置保持；不接管输入框、PDF 或图片查看器
- PR #117：选词翻译、双音标与本地朗读
- PR #120：可选译图生成及正文阅读模式同步
- PR #113：Tiptap 富文本笔记、Markdown 切换、Markmap；整合语言词条，保留现行导出测试，未恢复旧导出接口的过期测试

四个 PR 均以本地 merge commit 保留贡献者原始提交；没有推送、在 GitHub 合并或发布版本

## 本次检查

- 2026-10-28：取消自定义 agent 并补充退出等待后，`python -m unittest discover -s tests/engines -p test_opencode_runtime.py -v` 的 3 项测试通过，覆盖不注册或选择 agent、任务直接传入、工具权限限制、配置路径保留与异常退出后清理顺序；这是模拟子进程的适配器测试，不证明真实模型翻译成功
- 此前 62 项 Python 定向测试通过：裁图、旧 OpenCode 配置发现方案、选词 HTTP 接口、译图任务与图片引擎；该结果不代表当前直接调用方案已完成真实翻译验证
- 43 项 Node 定向测试通过：笔记保存、导图、选词与语音生命周期、译图及阅读数据保存
- 正文滚轮处理检查通过：正文调字号，输入框与外部面板不受影响
- 此前实际浏览器确认右侧笔记保存：修改富文本待办后，Markdown 中公式、链接、列表和代码块保留，修改已写入独立示例库；目录侧栏试验已撤回
- 英文词条缺失 0，未标记中文 0；`git diff --check` 通过

## 验证边界

- 2026-10-28 最新直接调用实测：Windows OpenCode 1.19.4 使用默认 `build` agent 到达 `opencode/deepseek-v4.1-flash-free`，日志返回 `Free usage limit reached`，没有 `Agent not found`；25 秒截止后适配器返回超时。补充退出等待前的同类调用出现 WinError 32，补充后不再出现该清理错误。结果与完整隔离日志留在 `outputs/opencode-validation/direct-results.json` 及 `direct-runtime-*`，未取得译文、未验证反馈者的 CLI 版本
- 2026-10-28：在独立测试目录下载并运行 Windows OpenCode 1.19.4，隔离配置、数据和凭证；真实 `opencode agent list` 在基线与候选补丁下均以 0 退出并发现 `easyread-reader (primary)`，未复现原报错，不能据此认定修复有效。结果保存在 `outputs/opencode-validation/results.json`
- 后续真实模型调用已尝试但没有取得译文，见下方记录；当前直接调用方案尚未完成真实模型翻译。issue 截图未提供 OpenCode 版本，未完成同版本复现。Docker CLI 存在，但 Docker Desktop Linux 引擎未运行
- 未调用真实生图模型，未试听本地语音，未跑全套测试、跨平台 CI、安装包构建或升级
- 未穷举富文本编辑器对所有 Markdown 扩展语法的兼容性
- 内嵌浏览器截图接口不可用；使用真实页面可访问性状态、元素边界和保存文件核对
- 示例库中的译图是预制素材，仅供阅读模式与布局检查，不是本次模型生成结果

预览：`http://127.0.0.1:8897/read/55a3e8328299`

OpenCode 参考：[官方配置](https://opencode.ai/docs/config/)、[官方 agent 文件格式](https://opencode.ai/docs/agents/)、[CLI 后台服务调用](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/run/run.ts)

## #118 版本差异定位（2026-10-28）

- 已重读原帖及两张截图：复现步骤是从 1.4.4 升级到 1.4.5 后，配置模型改为 OpenCode CLI，再启动翻译；没有提供 1.4.4 下 OpenCode CLI 翻译成功的记录
- `v1.4.4` 没有 OpenCode CLI 适配器、配置项或模型入口；`v1.4.5` 由提交 `3f8f98a1c450511b5aa34d30a69ed77b8825b0e6` 新增这些代码，属于新接入路径的问题，不能把 1.4.4 当作已证明可用的 OpenCode 对照版本
- 新路径固定执行 `opencode run --format json --agent easyread-reader`，通过 `OPENCODE_CONFIG_CONTENT` 声明该自定义 agent，然后在临时工作目录启动子进程。原帖的 OpenCode 终端截图使用内置 `Build` agent，终端能打开不等于该自定义 agent 已被识别
- 后续提交 `9b92f40` 修正了没有代理时环境字典为 `None` 的启动错误，正式 1.4.5 已含该修正；这与原帖已启动 OpenCode 后返回 `Agent not found` 不是同一种报错
- 已定位新增适配器中的 agent 选择与注册路径；尚未证明反馈者环境中注册失败的具体原因，候选补丁继续保持未确认修复状态
- 随后实际运行 Windows OpenCode 1.19.4，通过两版 `opencode_cli.run()` 向 `opencode/deepseek-v4.1-flash-free` 请求翻译一句合成英文。1.4.5 基线在约 72 秒后返回临时目录占用错误（WinError 32）；候选补丁在约 73 秒后超时。运行中读取的候选补丁日志确认 `agent=easyread-reader` 已进入模型调用，并收到 `Free usage limit reached`。没有拿到译文，未建立修改前出现原报错、修改后成功的对照。调用结果保存在 `outputs/opencode-validation/translation-results.json`；临时运行日志已随隔离目录清理，没有保留完整原版运行日志
