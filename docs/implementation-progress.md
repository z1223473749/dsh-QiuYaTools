# 双平台适配与电脑操控实施记录

本文件为 2026-10-21 的证据快照。分支为 `codex/cross-platform-computer-use`，开发版本为 `0.6.0-beta.1`。每个可验证步骤分别使用中文 Git 提交。三个平台候选已经产出并通过严格包校验，最终实测仍在收集；本记录不表示已经发布或完整复刻已经完成。

详细结果见 [测试报告](computer-use-test-report.md)，范围与原始门槛见 [开发计划](windows-and-computer-use-development-plan.md)。`passed` 只覆盖该行明列环境；`failed`、`blocked`、`not-run` 均不计为完成。

## 阶段进度

| 阶段 | 状态 | 已取得证据与剩余门槛 |
| --- | --- | --- |
| P0 基线与环境 | passed | 初始基线 393 项；Mac 完整检查 477/477、最终 Node 重跑 477/477。Windows 实际 Node 22.23.3 全量 477 项中 472 passed、5 skipped、0 failed；补齐旧归档 fixture 后单独 9/9。4 个 Mac 编译测试仅在 Mac 执行，不伪装 Windows 通过 |
| P1 原有功能 Windows 适配 | blocked | 平台资产、PE/架构/协议校验、原生会话分窗已实现；Mac 实际 Harness 10 项、Windows 旧 runtime 实际 Harness 10 项通过；微软拼音硬件输入 5/5。新 lock runtime 首轮 9/10（前台激活被拒），最终修复包宿主验证中。AltGr、全部 DPI/路径/窗口矩阵未完整验收 |
| P2 会话与输入控制核心 | passed | 类型化协议、授权、会话隔离、互斥、epoch、去重、取消/暂停/接管/继续、画面与几何校验、失败撤权/释放/迟到连接等回归通过；已纳入 477 项完整检查 |
| P3 主 Agent 与图像 | blocked | 实际 SDK 工具、附件与 adapter 运输通过；Mac 主 Agent 实际请求有 3 次带图请求、4 个图片块。当前缺少真正可用的视觉模型，确定性 adapter 不证明视觉推理 |
| P4A Mac 原生执行器 | blocked | ARM64 原生功能 11 项通过；通用构建与原生自测通过；新 guard 的只读、双 helper、正常转移及空租约崩溃恢复 4 项通过。真实按住拖动后 SIGKILL 恢复未完成，最新桌面锁屏；Intel/最低系统运行未验证 |
| P4B Windows 原生执行器 | passed（列明范围） | 最终隔离截图进程版在 PD Windows 11 ARM64 原生 47/47、Node 隐藏启动 5/5；截图集成 8/8，内含 14 项子进程故障注入与 20/20 真实不同动画帧。实际按住崩溃恢复与 owner 隔离通过。原生 x64、旧系统与部分物理 HID 场景不在此范围 |
| P5 悬浮实时预览 | blocked | Chromium 控制栏与实时指针 10 项、双端原生窗壳及实际按钮通过；模型观察与预览帧独立。Mac 长稳失败后被锁屏阻塞；Windows 原始 PrintWindow 长稳失败，已实现子进程隔离，完整动画长稳正在重跑。不能将 RPC 往返时间当作画面到 renderer 的延迟 |
| P6 独立环境 | blocked | 配对、撤权、心跳、取消回归通过；Mac → Windows 独立桌面 15 项通过。Windows → Mac 因 Mac 锁屏未完成；不以同来宾回环代替第二独立目标 |
| P7 浏览器通道 | passed | Mac Chrome、Windows ARM64 Edge 各 10 项实际浏览器检查通过；独立登录配置、显式 CDP、站点许可、导航/新建/关闭及注册 Agent 工具已验证；5 项释放失败回归已纳入完整检查。真实视觉推理由 P3 单独验收 |
| P8 安装与更新 | blocked | Mac 最终包官方管理器安装/升级/恢复/回滚/重装 5/5；Windows 上一候选相同 5 项通过，最终包重跑中。三包严格 native manifest/版本/架构/hash、64MiB 上限及隔离 Host 加载通过。双平台产包 workflow 已改，未远程执行；签名、公证、公开发布未完成 |
| P9 完整验收 | failed | 功能、安装与历史失败证据保留；长稳、Mac 解锁后 guard/反向任务、真实视觉模型及最终 Windows 宿主尚未整体通过，不能报告全部完成 |
| P10 Excel 与锁屏扩展 | not-run | 专用 Excel 加载项、macOS 锁屏操控尚未实现；需要对应 Office/加载项与系统会话环境的独立实现和验收 |

## 本轮完成的控制边界修复

- 授权写入串行化并遵循最新意图；撤权立即停止输入，不等待磁盘写入；失败写入不会复活授权。
- 独立跟踪真实 native lease epoch，保留失败释放与不确定获取，避免快照 epoch 前进后清错租约。
- 切换/卸载使用 generation 与取消信号；迟到连接不能重装执行器；失败退役在后续切换前重试；输入清理失败时仍尝试卸载全部 Host 路由。
- Windows 检查 `SendInput` 释放结果并保留 Unicode scan unit。两平台新增桌面互斥、持久输入记录与 guardian；旧 owner 的清理不得释放新 owner 的输入。Mac 真实按住后的恢复仍需解锁后验证。
- 浏览器 down 真正发送前记录释放命令，只有 CDP 确认 up 才移除；失败清理保留并阻止新租约；附着用户浏览器不通过强关用户浏览器掩盖清理失败。
- Windows 截图改到独立、无输入权的持久进程。2.5 秒超时或协议损坏后必须确认旧进程退出，才能对只读截图重试一次；无法确认退出时禁止替代进程。父 PID 与启动时间 watchdog 防止残留卡死进程，输入动作不重试。
- 发布组装验证 Windows 原生 manifest 必须与当前包版本一致，拒绝把旧原生文件重新标成新版；三包分架构生成，不提高安装器 64MiB 压缩上限。

## 当前阻塞与下一步

1. Mac 实际观测为 `screenLocked=1`、前台 `loginwindow`。已请求用户解锁；权限通过不等于当前桌面能接收前台输入。解锁后重跑 Mac guard 拖动崩溃恢复和反向独立环境任务。
2. Mac 30 分钟运行在显示器熄灭同一秒冻结。fixture 已加入其生命周期内的防显示器闲置休眠断言与实际 draw 遥测，编译通过；修复后的完整运行尚未通过。
3. Windows 排除 PD 暂停后仍于约 1,239 秒截图超时，作为产品问题修复；新隔离进程通过短测，33ms 动画完整长稳重跑中。历史中断及失败不删除，不能拼接成 30 分钟通过。
4. 完成最终 Windows 包的宿主及安装闭环，单独验证浮层手动输入，并绑定候选 SHA。上一轮产包源码提交 `c9b0644`（悬浮窗持续可见性修复后将重新冻结）；三包 hash、原生 manifest 与产物 hash 见 `artifacts/delivery-manifest.json`。
5. 取得可用图像模型后执行计划中的固定任务。`deepseek-flash` 配置和本机 `/v1/models` 503 都不是可用图像模型的证明。
6. 分别补 Intel Mac、原生 Windows x64、旧系统、AltGr/死键、物理多屏等矩阵；微软拼音 5 项已经实测，不扩大为全部输入法。P6 文件交换与 P10 专用扩展仍未实现。

主要证据在 `artifacts/computer-use/`、`artifacts/harness-e2e/` 与 `artifacts/install-e2e/`；系统会话与电源证据在 `artifacts/computer-use/environment-interruption/`。最终 Mac 安装证据为 `artifacts/install-e2e/macos-delivery-final/report.json`，对应包 SHA `8ae789043625df51a9dc9c22b956ee8c510badcba5ad897cf936143ea0d94a43`。历史候选 SHA 不得直接用于后续重打包资产。
