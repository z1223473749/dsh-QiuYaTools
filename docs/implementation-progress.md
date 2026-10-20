# 双平台适配与电脑操控实施记录

执行分支：`codex/cross-platform-computer-use`。按开发计划实施，每个可验证步骤单独提交；并行执行者不操作 Git 索引，提交由主执行者按文件范围完成。

| 步骤 | 状态 | 验证与结果 |
| --- | --- | --- |
| P0 当前代码基线 | passed | macOS ARM64：`npm run check`，393 passed，0 failed，0 skipped；原始日志 `artifacts/computer-use/baseline/check.log` |
| P0 Windows 测试入口 | passed | PD Windows 11 ARM64；真实登录桌面 Session 1 的交互 runner 已运行 |
| P1 Windows 全功能与更新 | in-progress | 已提交 Windows 资产选择、PE 与架构校验；46 项更新/分窗针对性测试通过；Windows 原生窗正在 PD 验收 |
| P2/P3 电脑控制核心与主 Agent | in-progress | 状态机、租约、取消、授权、实际 SDK 图像附件投影已提交；最新会话/工具测试 20 passed；真实视觉模型验收未运行 |
| P4A Mac 原生执行器 | passed | ARM64 真实 fixture：采集/AX/点击/Unicode/快捷键/滚动/悬浮窗重叠/拖动中接管/输入释放/旧租约零输入通过；最终原生自测通过；arm64+x86_64 通用二进制编译通过。证据 `artifacts/computer-use/macos-native/report.json`；Intel 与 macOS 13 运行未验证 |
| P4B Windows 原生执行器 | in-progress | PD 交互桌面 UIA、截图、输入与 WebView2 窗正在真实验收 |
| P5 悬浮预览 | in-progress | 真实 Chromium 控制栏、缩放点击、Unicode、继续/停止测试通过；双平台原生集成与性能待完成 |
| P6 独立环境 | in-progress | 配对、撤销、心跳失联释放等 8 项真实 HTTP 测试通过；跨 PD 真实输入验收待完成 |
| P7 浏览器 | in-progress | 独立 Chrome/Edge profile 与 CDP 通道实施中 |
| P8/P9 安装与完整验收 | not-run | 最终候选包、宿主全功能 E2E、双平台耐久和性能待完成 |
| P10 Excel 与锁屏 | not-run | 独立阶段；基础电脑操控通过不代表这些能力通过 |

以上仅为当前证据；后续每步更新状态与测试命令。原生架构运行、真实模型、系统权限、独立环境与安装包分别验收，未运行不计通过。
