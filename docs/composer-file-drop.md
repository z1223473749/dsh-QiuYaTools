# 输入区文件拖拽与内容预览

工具箱启用时，聊天输入区支持接收外部应用提供的文件拖拽数据。Windows 和 macOS 共用浏览器 File / DataTransfer 接收逻辑，不按扩展名过滤；允许多文件混合拖入和空文件。只有落在对应输入卡片内的文件拖拽会被接收，普通文字拖动保留原有行为。

拖入文件以新建的浏览器 File 接入原附件流程，保留文件名、类型、修改时间和字节内容，避免桌面端将原生文件转换为 `@path` 引用。上传、大小和数量校验、移除、失败重试、发送及草稿恢复继续由 Harness 管理。拖入不会自动发送，也不会替换已有草稿。

图片使用约 122×122 的缩略图；文件使用约 160×122 的紧凑卡片，上方为内容、下方为类型图标和文件名。文本、代码、Markdown、JSON 和长文本转换的 TXT 显示正文片段；CSV / TSV、XLSX 显示表格片段；DOCX 显示文档段落，PPTX 显示首张幻灯片文字，PDF 显示实际首页。Office 文件自带 PNG/JPEG 缩略图时优先使用。点击附件可放大查看当前预览，Escape 关闭。压缩包、旧版 DOC/XLS/PPT、其他未支持解析的格式，以及损坏或超限文档仍显示类型卡片，不影响原文件发送。

拖入、文件粘贴和原文件选择器共用上述入口，避免其中一种操作继续生成内联文件路径引用。手动输入的 `@` 代码引用保持原来的引用语义。

文本仅在本地读取前 16 KiB，支持 UTF-8 和带 BOM 的 UTF-16。Office 按需读取 ZIP 成员，每个成员最多 4 MiB、总计最多 12 MiB，并对分段解压输出校验边界。内容通过文本节点渲染，不执行文件中的脚本、宏或公式。PDF 在独立本地 worker 中按顺序生成首页，文件上限 32 MiB，超时 12 秒。PDF.js 的全局导出在打包时隔离，不覆盖 Harness 其他预览插件。完整原文件仍按原附件流程发送。

文件拖拽和预览随工具箱总开关启停，独立于长文本转换开关。卸载时恢复 Harness 原附件展示。文件夹会得到明确提示；只提供链接、应用内部对象或未暴露文件内容的来源应用不能凭空转换成附件，需要先导出为本地文件。

## 验证

相关回归覆盖混合文件、两种拖拽数据集合、原生路径去除与字节保留、空文件、跨卡片隔离、锁定与文件夹拒绝、重复安装清理、文本和表格解析、迟到预览读取、上传状态、移除与重试。

```sh
npm run typecheck
node --test tests/composer-attachments.test.mjs tests/pasted-text.test.mjs \
  tests/session-window-support.test.mjs tests/settings-features.test.mjs \
  tests/feature-switchboard.test.mjs tests/plugin.test.mjs \
  tests/host-package.test.mjs tests/harness-settings-acceptance.test.mjs \
  tests/harness-pasted-text-evidence.test.mjs
node scripts/e2e-harness.mjs --package /absolute/candidate.tgz \
  --pasted-text-only --attachments-only --output artifacts/composer-attachments-harness
```

2026-11-03：84 项相关回归通过，覆盖有效 DOCX/XLSX 内容解析、文件选择器与文件粘贴入口；在 macOS ARM64 的隔离 Harness / 无头 Chrome 中，6 项集成验收通过，使用有效 Word、Excel 和 PDF 文件核对真实 Host 上传、文件存储字节、内容预览、混合附件提交接受、草稿清理、浅深色和窄窗口截图。未使用真实模型账号。系统来源应用拖拽与 Windows 实机未在本次环境验收，不能用浏览器事件模拟结果代替这两项证据。

最终参考样式截图和报告位于 `artifacts/composer-attachments-reference-final/`。完整测试还包含本次无关的本地网络与 .NET SDK 依赖；沙箱内全量测试遇到 loopback `EPERM` 和缺少 SDK，未获得全量通过结果。

0.7.1 发布前补充验证：使用可用的 loopback 环境及 .NET SDK 8.0.426，`npm run check` 完成类型检查、Mac universal 构建和全量测试，3,272 项通过、0 失败、2 项按平台条件跳过。附件专项用例与原 Mac 完整验收隔离，保持原 12 项业务顺序、预检及超时约束，附件文档依赖仅在专项用例内按需加载。PDF worker 使用稳定的虚拟模块名，跨开发目录与 CI 目录的构建字节一致，产物不包含本机绝对路径。
