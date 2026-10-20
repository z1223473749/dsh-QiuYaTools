# 双平台适配与电脑操控实施记录

执行分支：`codex/cross-platform-computer-use`。按开发计划实施，每个可验证步骤单独提交；并行执行者不操作 Git 索引，提交由主执行者按文件范围完成。

| 步骤 | 状态 | 验证与结果 |
| --- | --- | --- |
| P0 当前代码基线 | passed | macOS ARM64：`npm run check`，393 passed，0 failed，0 skipped；原始日志 `artifacts/computer-use/baseline/check.log` |
| P0 Windows 测试入口 | passed | PD Windows 11 ARM64 正在运行，来宾命令可用；交互桌面 runner 与工具链准备中 |
| P1 Windows 全功能与更新 | in-progress | Windows 原生会话窗及双平台更新协议并行实施 |
| P2/P3 电脑控制核心与主 Agent | in-progress | 公开 SDK、会话状态机、输入租约与测试实施中 |
| P4 双平台原生执行器 | in-progress | Mac/Windows 执行器并行实施 |
| P5/P9 预览及完整验收 | not-run | 等待核心与原生执行器集成 |

以上仅为当前证据；后续每步更新状态与测试命令。原生架构运行、真实模型、系统权限、独立环境与安装包分别验收，未运行不计通过。
