# 桌面候选与正式发布

1. 发布 PR 在 main 对齐 package.json、pyproject.toml、easyread/__init__.py、锁文件和 CHANGELOG。确认目标 SHA 经过 PR 检查。获准准备构建后，从该 main 提交运行 Build desktop releases，候选 run 输入留空。记录 run ID、提交 SHA 和版本。
2. 三平台 job 原生打包并冒烟 frozen backend。每份 Actions 产物包含安装包、更新索引、相应 blockmap 及 candidate.json。下载同一 run 的三份产物，解压为 easyread-Windows、easyread-macOS、easyread-Linux。使用装有 PyYAML 的 Python 运行 `python scripts/release_candidate.py verify <解压根目录> --sha <完整提交> --version <版本>`。
3. 在隔离系统账户或测试机用旧库副本记录安装、首次打开、阅读、原句回跳和更新路径。记录平台、来源版本、候选 run、未验项。构建失败或验证失败留在候选阶段。
4. 获指定版本的发布授权后，确认 tag 指向已验提交，为该 tag 准备带手写说明的 GitHub Release 草稿。在该 tag 运行同一工作流，candidate_run 输入已验收的 run ID。工作流核对提交、版本、文件摘要、更新索引后上传到草稿并公开。上传失败仍可从同一 run 和草稿重试。候选过期需重新构建、验收。
5. 查看正式 Release 的安装包和更新清单，按实际版本回访 issue。配置 main 必过项时选择 CI 最终 job `EasyRead acceptance`；先在真实 PR 验证通过和失败两种结果。
