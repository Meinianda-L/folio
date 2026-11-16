# Folio Desktop rc3 适配记录

## 上游更新核对

- DSH 最新发布版本：`0.2.2-rc.3`（2026-11-13）。本机已安装这一版本，无需升级主程序。
- rc3 新增 DeepSeek 会话导入，修复 Windows 应用内更新。此前 rc2 对工具、会话与客户端扩展接口有调整，本分支以随桌面端分发的 rc3 源码和文档为适配依据。
- Folio 最新上游提交：`af190e338b7fa763a811d034dd20361440284c24`（2026-11-13）。包含未保存编辑保护、关闭/切换页面时保存、同名上传确认、长路径编译错误与警告定位等修复。本分支保留这些更新。

来源：[DSH rc3 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)、[Folio 上游提交](https://github.com/Meinianda-L/folio/commit/af190e338b7fa763a811d034dd20361440284c24)。

## 适配内容

Folio 原来的运行依赖固定安装 `0.2.1-rc.2` 的 `dsh-tools`、`dsh-llm`，在 Desktop profile 中会与宿主核心包冲突。现在改为可选 peer 依赖，使用宿主提供的版本；对应测试依赖仅放在 devDependencies 中。发布安装包包含预构建前端，不包含开发目录的 node_modules。

使用 rc3 的条件工具注册接口，只在绑定的文稿会话中激活 `folio_project`。保留每个写作会话的工具限制和人工审阅修改建议的流程。普通聊天不启用 Folio 工具。

声明支持范围为 `>=0.2.2-rc.3 <0.2.3-0`；实际验证版本为 rc3，不代表已验证后续版本。

## 验证

- 已通过：21 项测试全部通过，无跳过；覆盖真实 pdfLaTeX/BibTeX 编译、错误定位、跨文件 SyncTeX、项目文件、修改建议、导入和宿主工具激活。
- 已通过：发布包经 DSH 自带 pnpm 与普通 npm 各自进行隔离生产安装，两者都没有安装任何 DSH 核心包副本。
- 已通过：真实 Desktop 中 Folio、工具服务、会话与标签服务正常加载，核心模块来自应用内置包。
- 已通过：中文文稿新建、重命名、编辑及自动保存；内嵌助手收到测试消息并正常回复。
- 已通过：真实写作 Agent 的可见工具只有 `folio_project`。
- 已通过：在全新目录按 package-lock 执行 npm ci --legacy-peer-deps，前端构建成功。
- 已通过：MacTeX 2026 安装完成，真实 Desktop 中 XeLaTeX 编译中文 ctexart 文稿成功（约 2.4 秒，无问题），PDF 预览显示中文标题、摘要和公式。

## 本机 TeX 环境

验证环境为 macOS 27.0.1（Apple Silicon）、Desktop 0.2.2-rc.3、Node 24.21.0、MacTeX / TeX Live 2026。

系统原装 Biber 2.21 的 universal 启动程序调用 lipo 时失败；同一文件经系统 lipo 提取的 arm64 版本可运行，代码签名验证通过。这属于本机 TeX 工具环境问题，不改 Folio 的编译逻辑。原件已备份，替换需要用户管理员授权。使用待替换的 arm64 文件在临时验证目录运行 Folio 的 TeX 环境测试，pdfLaTeX、BibTeX、Biber、XeLaTeX、中文 ctex、LuaLaTeX 六项全部成功；系统原件的替换仍待用户完成，不把临时测试结果表述为系统 Biber 已修复。

