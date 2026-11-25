# 阅读功能的已定范围

维护者按相同的读者任务和实际效果引用先例。每次 Ed 改变取舍，在对应项补上日期、范围、依据和重开条件。是否已发布另查 tag、Release 和版本记录。

| 议题 | 当前决定与验收 |
| --- | --- |
| 既有行为失效 | 直接修。公式选区应和正文一样能划线并在重开后保留。旧论文术语缺字段时能直接续译。维护者在受影响入口复验。[#84](https://github.com/Edwardxlai/easyread/issues/84#issuecomment-6195380874) · [#147](https://github.com/Edwardxlai/easyread/pull/147#issuecomment-6705864364) |
| 混合需求 | 分开处理。SQL 换行、Ollama 温度被覆盖，均按缺陷修。手动免译、EPUB、独立 JSON 修复模型各是独立扩展。[#139](https://github.com/Edwardxlai/easyread/issues/139#issuecomment-6705861005) · [#132](https://github.com/Edwardxlai/easyread/issues/132#issuecomment-6705858706) |
| 全库 AI 搜索 | 2026-11-13 确认 1.5 方向。对两篇用词不同的论文提问，引文分别回到文献及原句，记录送入模型的段数和用量。现有元数据搜索只覆盖找标题。[#160](https://github.com/Edwardxlai/easyread/issues/160) |
| 网页与博客 | 2026-11-13 接受阅读来源。复用批注和导出，部分资源归档失败后，断网打开 HTML 仍可读、批注可定位。读取文献列表时给旧文章写封面需拆出。原 PR 是否纳入根据实际 diff 决定。[#162](https://github.com/Edwardxlai/easyread/pull/162#issuecomment-6790043865) |
| 目录和图文对照 | 2026-11-13 确认 1.5 沿用目录抽屉，已有 T 键。持续出现抽屉解决不了的任务时再讨论固定目录。图文对照保留需求，优先从正文图片或已有侧栏按需打开。[#135](https://github.com/Edwardxlai/easyread/issues/135#issuecomment-6595252805) · [#164](https://github.com/Edwardxlai/easyread/pull/164) · [#155](https://github.com/Edwardxlai/easyread/pull/155#issuecomment-6790041737) |
| 供应商与新 CLI | 可用兼容接口配置的给实际路径。Atlas Cloud、Requesty 和 omp 集中到模型选择设计再评估。同类请求归同一议题；已支持引擎的适配回归照常修。[#151](https://github.com/Edwardxlai/easyread/pull/151#issuecomment-6790040231) · [#149](https://github.com/Edwardxlai/easyread/pull/149#issuecomment-6790038770) · [#143](https://github.com/Edwardxlai/easyread/pull/143#issuecomment-6790037273) |
| 阅读与相邻工具 | 阅读中的引文导航、摘录回跳已有先例。PDF 原文件编辑、浏览器采集和 Word 引用插件目前暂缓；新增长期适配需明确现有路径解决不了什么。[#131](https://github.com/Edwardxlai/easyread/pull/131#issuecomment-6705858150) · [#142](https://github.com/Edwardxlai/easyread/pull/142#issuecomment-6705862188) · [#101](https://github.com/Edwardxlai/easyread/issues/101#issuecomment-6287494789) · [#90](https://github.com/Edwardxlai/easyread/issues/90#issuecomment-6250929004) |
| 原文阅读与双 PDF | 2026-11-15：#139 按不计划关闭，保留整篇原文阅读、逐段展开原文和已发布的 SQL 换行修复。#167 不做应用内左原版 PDF、右译版 PDF 的专用布局。1.5 多面板侧栏继续用于正文旁按需对照。若需要两份独立 PDF，沿用可选中文 PDF 导出。 [#139](https://github.com/Edwardxlai/easyread/issues/139) · [#167](https://github.com/Edwardxlai/easyread/issues/167) |
| 按提示词整理已有文献 | 2026-11-24 确认在自建分类内提供「智能分类」。读者输入标准、选择论文，用默认问答模型核对原文，看到引句后勾选加入该分类，保留原有归属。独立标签、自动建标签和标签合并暂缓。[#175](https://github.com/Edwardxlai/easyread/pull/175) · [#176](https://github.com/Edwardxlai/easyread/issues/176) |
